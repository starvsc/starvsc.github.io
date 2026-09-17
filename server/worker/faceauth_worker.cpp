// faceauth_worker —— 常驻人脸比对服务(模型只加载一次,复用,大幅降低冷启动耗时)
//
// 与"每次请求 fork 一个 CLI、重新加载 onnx"不同,本 worker 启动时加载一次
// ArcFace + SCRFD 模型,然后循环从 stdin 读取"一行一个请求",处理后向 stdout
// 输出"一行一个 JSON"。网关(server/app.py)启动它并串行转发请求,使单次
// 比对只剩特征提取 + 数据库耗时(网页端 5s → 约 1~2s)。
//
// 行协议(空格分隔,路径/用户名为 ASCII 临时文件与用户名):
//   ping
//   compare <imgA> <imgB>
//   verify  <username> <img>
//   register <username> <n> <img1> [img2 ...]
//
// 输出示例(与队友 CLI 同字段,网关无需改解析):
//   {"ok":true,"same":true,"score":0.7440,"threshold":0.2880,"elapsed_ms":800.0}
//   {"ok":true,"accepted":true,"score":0.71,"threshold":0.2880,"elapsed_ms":600.0}
//   {"ok":true,"user_id":1,"stored_samples":3,"elapsed_ms":400.0}
//   {"ok":false,"error":"..."}
//
// 注意:stdout 只输出结果 JSON;日志一律走 stderr。cwd 需为 faceauth 根(读 faceauth.ini/models)。
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "faceauth/faceauth.h"

using namespace faceauth;

static double now_ms() {
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

// 大图降采样防御:解码后若最长边 > maxSide 先等比缩小,再送检测/提特征。
// SCRFD 内部固定 letterbox 到 640、ArcFace 固定 112,过大输入只会增加解码/内存,
// 对精度几乎无损;同时避免超大图让检测链路做无用功。
static void guard_size(cv::Mat& m, int maxSide = 1600) {
    if (m.empty()) return;
    const int w = m.cols, h = m.rows;
    const int mx = std::max(w, h);
    if (mx <= maxSide) return;
    const double s = static_cast<double>(maxSide) / static_cast<double>(mx);
    cv::Mat out;
    cv::resize(m, out, cv::Size(static_cast<int>(w * s), static_cast<int>(h * s)),
               0, 0, cv::INTER_AREA);
    m = out;
}

static std::string jesc(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (char c : s) {
        if (c == '"' || c == '\\') { o.push_back('\\'); o.push_back(c); }
        else if (c == '\n') o += "\\n";
        else o.push_back(c);
    }
    return o;
}

// 读一张图;失败返回 false
static bool load_img(const std::string& path, cv::Mat* out) {
    cv::Mat m = cv::imread(path, cv::IMREAD_UNCHANGED);
    if (m.empty()) return false;
    *out = std::move(m);
    return true;
}

static void reply_ok(const std::string& body) { std::printf("{\"ok\":true,%s}\n", body.c_str()); std::fflush(stdout); }
static void reply_err(const std::string& msg)  { std::printf("{\"ok\":false,\"error\":\"%s\"}\n", jesc(msg).c_str()); std::fflush(stdout); }

int main(int argc, char** argv) {
    (void)argc; (void)argv;
    AppConfig cfg;
    std::string err;
    if (!load_config(default_config_path(), &cfg, &err)) {
        std::fprintf(stderr, "[worker] 配置加载失败: %s\n", err.c_str());
        return 2;
    }

    // —— SM4 密钥已由 load_config 从 FACE_KEY / db.encryption_key 统一装载；
    //    这里仅回显当前加密开关状态，便于运维确认。 ——
    std::fprintf(stderr, cfg.db.encryption_key.empty()
                              ? "[worker] 警告: 未设置 FACE_KEY，特征将以明文入库\n"
                              : "[worker] 已启用 SM4-GCM 特征加密\n");

    FaceExtractor ex;
    if (!ex.load(cfg.model_path, &err)) {
        std::fprintf(stderr, "[worker] 模型加载失败: %s\n", err.c_str());
        return 2;
    }
    std::fprintf(stderr, "[worker] ArcFace 模型加载成功: %s\n", cfg.model_path.c_str());
    if (!ex.load_detector(cfg.det_path, &err)) {
        std::fprintf(stderr, "[worker] 警告: 检测器加载失败(用 Haar 兜底): %s\n", err.c_str());
    } else {
        std::fprintf(stderr, "[worker] SCRFD 检测器加载成功\n");
    }

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        std::istringstream ss(line);
        std::string op;
        ss >> op;

        if (op == "ping") { reply_ok("\"pong\":true"); continue; }

        const double t0 = now_ms();

        try {
            if (op == "compare") {
                std::string a, b;
                ss >> a >> b;
                if (a.empty() || b.empty()) { reply_err("usage: compare <imgA> <imgB>"); continue; }
                cv::Mat ma, mb;
                if (!load_img(a, &ma) || !load_img(b, &mb)) { reply_err("图片读取失败"); continue; }
                guard_size(ma);
                guard_size(mb);
                const double t1 = now_ms();   // 解码+降采样完成
                Embedding ea, eb;
                if (!ex.extract(ma, &ea, &err)) { reply_err("imgA 提特征失败: " + err); continue; }
                const double t2 = now_ms();   // 图A 提取完成
                if (!ex.extract(mb, &eb, &err)) { reply_err("imgB 提特征失败: " + err); continue; }
                const double t3 = now_ms();   // 图B 提取完成
                std::fprintf(stderr, "[worker] compare 解码=%.0fms 提A=%.0fms 提B=%.0fms 总=%.0fms\n",
                             t1 - t0, t2 - t1, t3 - t2, t3 - t0);
                std::fflush(stderr);
                const float score = cosine_similarity(ea.data, eb.data);
                const bool same = is_same_person(score, cfg.threshold);
                char buf[256];
                std::snprintf(buf, sizeof(buf),
                              "\"same\":%s,\"score\":%.4f,\"threshold\":%.4f,\"elapsed_ms\":%.1f",
                              same ? "true" : "false", score, cfg.threshold, now_ms() - t0);
                reply_ok(buf);
            } else if (op == "verify") {
                std::string user, img;
                ss >> user >> img;
                if (user.empty() || img.empty()) { reply_err("usage: verify <username> <img>"); continue; }
                cv::Mat m;
                if (!load_img(img, &m)) { reply_err("图片读取失败"); continue; }
                guard_size(m);
                Embedding probe;
                if (!ex.extract(m, &probe, &err)) { reply_err("提特征失败: " + err); continue; }
                FaceAuthDb db(cfg.db);
                VerifyResult r = db.verify(user, probe, cfg.threshold);
                if (!r.ok) { reply_err("认证流程失败: " + r.message); continue; }
                char buf[256];
                std::snprintf(buf, sizeof(buf),
                              "\"accepted\":%s,\"score\":%.4f,\"threshold\":%.4f,\"elapsed_ms\":%.1f",
                              r.accepted ? "true" : "false", r.score, cfg.threshold, now_ms() - t0);
                reply_ok(buf);
            } else if (op == "register") {
                std::string user;
                int n = 0;
                ss >> user >> n;
                if (user.empty() || n <= 0) { reply_err("usage: register <username> <n> <img1> ..."); continue; }
                std::vector<cv::Mat> ims;
                for (int i = 0; i < n; ++i) {
                    std::string p;
                    ss >> p;
                    cv::Mat m;
                    if (!load_img(p, &m)) { reply_err("图片读取失败: " + p); continue; }
                    guard_size(m);
                    ims.push_back(std::move(m));
                }
                FaceAuthDb db(cfg.db);
                RegisterResult r = db.register_with_images(user, ims, &ex, &err);
                if (!r.ok) { reply_err("注册失败: " + r.message); continue; }
                char buf[256];
                std::snprintf(buf, sizeof(buf),
                              "\"user_id\":%lld,\"stored_samples\":%d,\"elapsed_ms\":%.1f",
                              static_cast<long long>(r.user_id), r.stored_samples, now_ms() - t0);
                reply_ok(buf);
            } else {
                reply_err("未知操作: " + op);
            }
        } catch (const std::exception& e) {
            reply_err(std::string("worker 异常: ") + e.what());
        }
    }
    return 0;
}