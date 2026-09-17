#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人脸识别认证 Web 网关(server/app.py)
=====================================
把“队友的 C++ faceauth 识别模块(CLI)” + MySQL 账号口令 桥接成前端可用的 REST API。

后端能力:
  - 同源托管前端静态页(index.html / css / js / debug.html ...)
  - REST(JSON):/api/v1/auth/register | /api/v1/auth/login |
                /api/v1/face/verify | /api/v1/face/enroll | /api/v1/health
  - MySQL:账号口令存 web_accounts(PBKDF2-SHA256 + 盐),见 sql/schema_web.sql
  - 人脸比对:把前端传来的 dataURL 存临时文件,subprocess 调队友 CLI
      faceauth_register / faceauth_verify(输出 JSON 行,退出码 0/1/2)
  - 活体审计:每次认证/注册把前端 liveness 记录落 logs/audit.jsonl

运行(在 server/ 目录):
  cp config.example.json config.json      # 按你机器改路径
  pip3 install pymysql                     # 唯一第三方依赖(纯Python)
  python3 app.py                           # 默认 http://127.0.0.1:8000

依赖回顾(Ubuntu 20.04,队友侧):libopencv-dev / mysql-server /
libmysqlclient-dev / onnxruntime(通常 /opt/onnxruntime) /
模型 models/*.onnx —— 这些由队友 README 的 setup_m0.sh 安装。
"""
import base64
import hashlib
import hmac
import json
import os
import re
import select
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    import pymysql
except ImportError:  # pragma: no cover
    pymysql = None

SERVER_DIR = Path(__file__).resolve().parent

# ---------------- 配置 ----------------

DEFAULTS = {
    "host": "127.0.0.1",
    "port": 8000,
    # 相对 server/ 的路径
    "web_root": "..",                # 前端根(含 index.html)
    "face_delivery": "../faceauth",  # 队友 faceauth 目录(含 faceauth.ini/models/build)
    "cli_register": "build/faceauth_register",
    "cli_verify": "build/faceauth_verify",
    "cli_compare": "build/faceauth_compare2",
    "cli_pad": "build/faceauth_pad",   # 静态介质检测 CLI
    "cli_auth": "build/faceauth_auth",   # 融合认证 CLI(多帧)
    # 时序活体策略,透传给 faceauth_auth --temporal-policy:
    #   "spoof" 宽松(默认):仅 SPOOF 拒绝,拿不准时放行 —— 模块三只出风险分,
    #                       放行交上层(与模块二 static_media 融合决策)。
    #   "live"  严格:只有模块三判 LIVE 才放行。⚠ 必须配合 use_blink=true,
    #                否则关掉眨眼后本层不判 LIVE,会导致所有人都登录不了。
    "temporal_policy": "spoof",
    # 是否把眨眼证据并入模块三判决(透传 --use-blink)。
    # 默认 false:光流线索在回放视频里同样存在,给不出正面活体证据,
    # 所以本层只输出风险分与光流强证据;置 true 可恢复「必须眨眼」的严格模式。
    # 模块二(static_media)× 模块三(时序)融合阈值(透传 --joint-risk-thr)。
    #   combined = max(pad_score, risk/100) + 0.3 × min(...),即「互补证据」语义,
    #   单通道的强证据不会被另一路投票稀释。
    #   1.0 = 关闭(默认,不引入未标定的拒绝路径)。
    #   按场景估算,可分离区间约为 (0.57, 0.81],建议标定时从 0.70 起调。
    "joint_risk_thr": 1.0,
    # 透传给 faceauth_auth 的附加参数(标定用,无需改代码)。示例:
    #   ["--ear-close-thr", "0.24", "--ear-deep-thr", "0.20",
    #    "--frozen-energy-thr", "0.10", "--risk-spoof-thr", "90"]
    "cli_auth_extra_args": [],
    "pad_enabled": True,               # 关闭则完全跳过此预检
    "pad_lib_paths": ["/opt/openssl3/lib", "/usr/local/lib"],  # pad 运行所需库
    "admin_reg_key": "",              # 管理员注册邀请密钥;留空=仅允许首个管理员注册
    "admin_token_ttl_s": 7200,        # 管理员登录令牌有效期(秒)
    "onnxruntime_lib": "/opt/onnxruntime/lib",   # 加入 LD_LIBRARY_PATH(不存在则忽略)
    "worker_bin": "worker/build/faceauth_worker",  # 常驻模型服务(编译后优先使用,大幅提速)
    "audit": "logs/audit.jsonl",     # 活体审计日志(相对 server/)
    "db": {
        "host": "127.0.0.1",
        "port": 3306,
        "user": "faceauth",
        "password": "faceauth123",
        "database": "face_auth",
        "charset": "utf8mb4",
    },
    "pbkdf2_iterations": 120_000,
    "max_body_mb": 20,
}


def _load_config():
    cfg = json.loads(json.dumps(DEFAULTS))  # 深拷贝
    path = os.environ.get("FACE_WEB_CONFIG")
    if not path:
        p = SERVER_DIR / "config.json"
        path = str(p) if p.exists() else ""
    if path:
        with open(path, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
        cfg.setdefault("db", {})
        for k, v in DEFAULTS["db"].items():
            cfg["db"].setdefault(k, v)
        print(f"[gateway] 加载配置: {path}")
    else:
        print("[gateway] 未找到 config.json,使用内置默认(web_root=.., face_delivery=../faceauth)")
    return cfg


CFG = _load_config()
WEB_ROOT = (SERVER_DIR / CFG["web_root"]).resolve()
FACE_ROOT = (SERVER_DIR / CFG["face_delivery"]).resolve()
CLI_REGISTER = FACE_ROOT / CFG["cli_register"]
CLI_VERIFY = FACE_ROOT / CFG["cli_verify"]
CLI_COMPARE = FACE_ROOT / CFG["cli_compare"]
CLI_PAD = FACE_ROOT / CFG["cli_pad"]
CLI_AUTH = FACE_ROOT / CFG["cli_auth"]
PAD_ENABLED = bool(CFG.get("pad_enabled", False))
AUDIT_PATH = (SERVER_DIR / CFG["audit"]).resolve()
MAX_BODY = int(CFG.get("max_body_mb", 20)) * 1024 * 1024

# 常驻模型 worker(优先使用;编译 worker 后会自动提速)
WORKER_BIN = (SERVER_DIR / CFG.get("worker_bin", "worker/build/faceauth_worker")).resolve()
_worker = None
_worker_ok = False
_worker_lock = threading.Lock()

# TLS 证书:server/certs/cert.pem + key.pem 存在则启用 HTTPS(否则回退 HTTP)
CERTS_DIR = SERVER_DIR / "certs"
CERT_FILE = CERTS_DIR / "cert.pem"
KEY_FILE = CERTS_DIR / "key.pem"

def tls_available():
    return CERT_FILE.is_file() and KEY_FILE.is_file()

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".md": "text/plain; charset=utf-8",
}


# ---------------- 小工具 ----------------

def _res(path):
    """把相对 server/ 的路径解析为绝对路径,并确保在 WEB_ROOT 内"""
    p = (WEB_ROOT / path).resolve()
    if p != WEB_ROOT and not str(p).startswith(str(WEB_ROOT) + os.sep):
        raise ValueError("非法路径")
    return p


def json_body(content):
    return {"code": 0, "message": "ok", "data": content}


def json_err(code, message):
    return {"code": code, "message": message, "data": None}


def _json_safe(v):
    """转 JSON 友好类型(日期/字节等)"""
    if hasattr(v, "isoformat"):      # datetime/date
        try: return v.isoformat(sep=" ")
        except TypeError: return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8", "replace")
    return v


def send_json(handler, payload, http=200):
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(http)
    handler._cors()
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(raw)


def decode_data_url(data_url):
    m = re.match(r"^data:(image/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$", data_url or "")
    if not m:
        return None
    return base64.b64decode(m.group(2))


def audit(event, username, payload):
    """活体审计(需求7:攻击告警/留痕)——前端传的 liveness 记录在此落盘"""
    try:
        AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        rec = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "event": event,
            "username": username,
            **payload,
        }
        with open(AUDIT_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001  审计失败不应阻断认证
        pass


# ---------------- MySQL(口令) ----------------

def _db():
    if pymysql is None:
        raise RuntimeError("缺少 pymysql,请先执行: pip3 install pymysql")
    d = CFG["db"]
    return pymysql.connect(
        host=d["host"], port=int(d.get("port", 3306)),
        user=d["user"], password=d["password"], database=d["database"],
        charset=d.get("charset", "utf8mb4"), autocommit=True,
        connect_timeout=int(d.get("connect_timeout_s", 5)),
    )


def hash_password(password, salt_hex, iterations):
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                             bytes.fromhex(salt_hex), iterations)
    return dk.hex()


def new_account(username, display_name, password):
    if not re.fullmatch(r"[A-Za-z0-9_]{4,20}", username):
        return None, "账号需为 4-20 位字母/数字/下划线"
    if len(password or "") < 8:
        return None, "密码长度至少 8 位"
    salt = os.urandom(16).hex()
    h = hash_password(password, salt, CFG["pbkdf2_iterations"])
    conn = _db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO web_accounts(username, display_name, salt, password_hash) "
                "VALUES(%s, %s, %s, %s)",
                (username, (display_name or username), salt, h),
            )
        return {"username": username, "displayName": (display_name or username)}, None
    except pymysql.IntegrityError:
        return None, "该账号已存在,请直接登录"
    finally:
        conn.close()


def check_account(username, password):
    conn = _db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT display_name, salt, password_hash FROM web_accounts "
                "WHERE username=%s", (username,))
            row = cur.fetchone()
        if not row:
            return None, "账号或密码错误"
        display_name, salt, stored = row
        calc = hash_password(password or "", salt, CFG["pbkdf2_iterations"])
        if not hmac.compare_digest(calc, stored):
            return None, "账号或密码错误"
        # 是否已有人脸特征
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM face_features WHERE username=%s", (username,))
            cnt = cur.fetchone()[0]
        return {"username": username, "displayName": display_name, "faceRegistered": cnt > 0}, None
    finally:
        conn.close()



# ---------------- 管理端(admins 表;账号密码,无人脸) ----------------

def new_admin(username, display_name, password):
    if not re.fullmatch(r"[A-Za-z0-9_]{4,20}", username):
        return None, "账号需为 4-20 位字母/数字/下划线"
    if len(password or "") < 8:
        return None, "密码长度至少 8 位"
    salt = os.urandom(16).hex()
    h = hash_password(password, salt, CFG["pbkdf2_iterations"])
    conn = _db()
    try:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO admins(username, display_name, salt, password_hash) "
                        "VALUES(%s, %s, %s, %s)",
                        (username, (display_name or username), salt, h))
        return {"username": username, "displayName": (display_name or username)}, None
    except pymysql.IntegrityError:
        return None, "该管理员账号已存在"
    finally:
        conn.close()


def check_admin(username, password):
    conn = _db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT display_name, salt, password_hash FROM admins WHERE username=%s", (username,))
            row = cur.fetchone()
        if not row:
            return None, "管理员账号或密码错误"
        display_name, salt, stored = row
        calc = hash_password(password or "", salt, CFG["pbkdf2_iterations"])
        if not hmac.compare_digest(calc, stored):
            return None, "管理员账号或密码错误"
        return {"username": username, "displayName": display_name}, None
    finally:
        conn.close()


def list_registered_users():
    conn = _db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT wa.username, wa.display_name, wa.created_at, "
                        "(SELECT COUNT(*) FROM face_features ff WHERE ff.username = wa.username) AS face_count "
                        "FROM web_accounts wa ORDER BY wa.created_at DESC")
            rows = cur.fetchall()
        users = []
        for r in rows:
            created = r[2].isoformat(sep=" ") if hasattr(r[2], "isoformat") else str(r[2])
            users.append({"username": r[0], "displayName": r[1] or r[0],
                          "createdAt": created, "faceCount": int(r[3] or 0)})
        return users, None
    finally:
        conn.close()

# ---------------- 管理员登录令牌(内存态;单进程网关) ----------------

_ADMIN_TOKENS = {}
_ADMIN_TOKENS_LOCK = threading.Lock()


def _issue_admin_token(username):
    tok = os.urandom(24).hex()
    ttl = int(CFG.get("admin_token_ttl_s", 7200))
    with _ADMIN_TOKENS_LOCK:
        _ADMIN_TOKENS[tok] = {"username": username, "exp": time.time() + ttl}
    return tok, ttl


def _admin_token_ok(tok):
    if not tok:
        return None
    with _ADMIN_TOKENS_LOCK:
        rec = _ADMIN_TOKENS.get(tok)
        if not rec:
            return None
        if rec["exp"] < time.time():
            _ADMIN_TOKENS.pop(tok, None)
            return None
        return rec["username"]


def _admin_count():
    conn = _db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM admins")
            return int(cur.fetchone()[0])
    finally:
        conn.close()


# ---------------- 调队友 C++ CLI ----------------

def _cli_env():
    env = dict(os.environ)
    ort = CFG.get("onnxruntime_lib")
    if ort and Path(ort).is_dir():
        env["LD_LIBRARY_PATH"] = ort + (os.pathsep + env["LD_LIBRARY_PATH"] if env.get("LD_LIBRARY_PATH") else "")
        # 静态介质 CLI(faceauth_pad)依赖 /opt/openssl3 与 /usr/local 下的 OpenCV
    for d in CFG.get("pad_lib_paths", []):
        if os.path.isdir(d):
            env["LD_LIBRARY_PATH"] = d + (os.pathsep + env["LD_LIBRARY_PATH"]
                                          if env.get("LD_LIBRARY_PATH") else "")
    return env


def run_cli(cli, args, timeout=180):
    if not cli.is_file():
        raise FileNotFoundError(f"找不到 CLI: {cli} (请检查 config.json 的 face_delivery/已编译 build/)")
    cmd = [str(cli)] + args
    proc = subprocess.run(cmd, cwd=str(FACE_ROOT), capture_output=True,
                          text=True, timeout=timeout, env=_cli_env())
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def _parse_stdout_json(out):
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    return None


# ---------------- 常驻模型 worker(模型只加载一次,大幅提速) ----------------

def _worker_stop():
    global _worker, _worker_ok
    _worker_ok = False
    w = _worker
    _worker = None
    if w is not None:
        try:
            if w.poll() is None:
                w.kill()
        except Exception:
            pass


def _worker_start():
    global _worker, _worker_ok
    if _worker_ok and _worker is not None and _worker.poll() is None:
        return True
    if not WORKER_BIN.is_file():
        print("[gateway] 未找到常驻 worker 二进制,使用 CLI 模式(每次请求冷启动,较慢)")
        return False
    try:
        proc = subprocess.Popen([str(WORKER_BIN)], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=None,   # 继承网关日志,便于看 worker 分阶段计时
                                cwd=str(FACE_ROOT), env=_cli_env())
    except Exception as e:
        print("[gateway] worker 启动失败,回退 CLI:", e)
        return False
    _worker = proc
    ok = _worker_exchange("ping", 8.0)
    _worker_ok = bool(ok and ok.get("pong") is True)
    if not _worker_ok:
        _worker_stop()
        print("[gateway] worker 心跳失败,回退 CLI")
    else:
        print("[gateway] 常驻 worker 就绪(模型常驻,请求免冷启动)")
    return _worker_ok


def _worker_read_line(proc, timeout):
    fd = proc.stdout.fileno()
    buf = b""
    deadline = time.time() + timeout
    while b"\n" not in buf:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise TimeoutError("worker 响应超时")
        r, _, _ = select.select([fd], [], [], remaining)
        if not r:
            raise TimeoutError("worker 响应超时")
        chunk = os.read(fd, 65536)
        if not chunk:
            raise EOFError("worker 已退出")
        buf += chunk
    line, _, _ = buf.partition(b"\n")
    return line.decode("utf-8", "replace").strip()


def _worker_exchange(request, timeout=60):
    """向 worker 发一行、收一行 JSON;通信失败返回 None"""
    with _worker_lock:
        if _worker is None or _worker.poll() is not None:
            return None
        try:
            _worker.stdin.write((request + "\n").encode("utf-8"))
            _worker.stdin.flush()
            resp = _worker_read_line(_worker, timeout)
            return json.loads(resp) if resp.startswith("{") else None
        except Exception:
            _worker_stop()
            return None


# ---------- 底层实现(逐个进程调用队友 CLI) ----------

def _register_features_cli(username, img_paths):
    rc, out, err = run_cli(CLI_REGISTER, ["--user", username] + img_paths)
    if rc != 0:
        return None, (err or out or f"注册失败(退出码 {rc})")
    obj = _parse_stdout_json(out) or {}
    return {"user_id": obj.get("user_id"), "sampleCount": obj.get("stored_samples", len(img_paths))}, None


def _verify_features_cli(username, img_path):
    rc, out, err = run_cli(CLI_VERIFY, ["--user", username, img_path])
    if rc == 2:
        return None, (err or out or "认证流程失败(可能该账号尚未录入人脸)")
    obj = _parse_stdout_json(out) or {}
    return {
        "passed": bool(obj.get("accepted", False)),
        "score": float(obj.get("score", 0.0)),
        "threshold": float(obj.get("threshold", 0.288)),
        "spoof": False,
        "elapsedMs": float(obj.get("elapsed_ms", 0.0)),
        "message": "",
    }, None


def _compare_features_cli(imgA, imgB):
    rc, out, err = run_cli(CLI_COMPARE, [imgA, imgB])
    if rc == 2:
        return None, (err or out or "比对出错:可能某张图未检出人脸")
    obj = _parse_stdout_json(out) or {}
    return {
        "score": float(obj.get("score", 0.0)),
        "threshold": float(obj.get("threshold", 0.288)),
        "same": bool(obj.get("same", False)),
        "elapsedMs": float(obj.get("elapsed_ms", 0.0)),
    }, None

def _pad_check(img_path):
    """对单帧跑静态介质检测。攻击->True;无脸/出错/未启用->False(不误拦)。"""
    if not PAD_ENABLED or not CLI_PAD.is_file():
        return None
    try:
        rc, out, err = run_cli(CLI_PAD, [img_path, "--json"])
    except Exception as e:
        print(f"[gateway] pad 执行异常: {e!r}")
        return None
    obj = _parse_stdout_json(out) or {}
    return obj if isinstance(obj, dict) and obj else None

def _save_frames(frame_list):
    """把前端多帧(dataURL+face+landmarks)落盘,并生成 faceauth_auth 的 clip 清单。

    时间戳优先取前端给的真实 ts(相对采集起点的毫秒);只有整段都缺 ts 时才回退
    40ms 等间隔(兼容旧前端,并打印告警)。时间戳是模块三全部时序判据的地基,
    不能像旧版那样一律硬编码 i*40 —— 那会让 14 帧只换来 520ms 的窗口,
    使时序层恒为 INCONCLUSIVE。
    """
    d = Path(tempfile.mkdtemp(prefix="gateway_auth_", dir=str(SERVER_DIR)))
    rows = []          # [ts, 原始序号, 路径, x, y, w, h, landmarks]
    try:
        for i, fr in enumerate(frame_list):
            raw = decode_data_url((fr.get("image") or ""))
            if not raw:
                raise ValueError("帧图片 dataURL 格式错误")
            p = d / f"f_{i}.jpg"
            p.write_bytes(raw)
            face = fr.get("face") or {}
            x = int(face.get("x", 0)); y = int(face.get("y", 0))
            w = int(face.get("width", face.get("w", 0)))
            h = int(face.get("height", face.get("h", 0)))
            if w <= 0 or h <= 0:
                raise ValueError(f"第 {i} 帧缺少有效人脸框 face")
            lm = fr.get("landmarks") or []
            if len(lm) != 136:
                lm = []                     # 无 68 点 => Cue A 禁用
            try:
                ts = int(round(float(fr.get("ts"))))
            except (TypeError, ValueError):
                ts = None
            rows.append([ts, i, p, x, y, w, h, lm])

        if all(r[0] is None for r in rows):
            print(f"[gateway] 警告: {len(rows)} 帧均未携带 ts,按 40ms 等间隔回退"
                  f"(时序判定将不可靠,请确认前端已更新)")
            for i, r in enumerate(rows):
                r[0] = i * 40
        else:
            prev = 0                        # 个别缺 ts:用前一帧 +40ms 兜底
            for r in rows:
                if r[0] is None:
                    r[0] = prev + 40
                prev = r[0]
        rows.sort(key=lambda r: r[0])       # 保证 clip 时间戳单调递增

        lines = []
        for ts, _i, p, x, y, w, h, lm in rows:
            if not lm:
                lines.append(f"{ts} {p} {x} {y} {w} {h} 0")
            else:
                pts = " ".join(str(float(v)) for v in lm)
                lines.append(f"{ts} {p} {x} {y} {w} {h} 68 {pts}")
        clip = d / "clip.txt"
        clip.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return clip, d
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise


def _run_auth_cli(username, frames):
    """多帧融合认证:static_media + mod3 时序 + 1:1,输出 JSON 字段"""
    clip, tmp = _save_frames(frames)
    try:
        policy = str(CFG.get("temporal_policy", "live") or "live")
        extra = CFG.get("cli_auth_extra_args") or []
        cmd = ["--user", username, "--clip", str(clip), "--temporal-policy", policy]
        cmd += ["--use-blink", "1" if CFG.get("use_blink") else "0"]
        cmd += ["--joint-risk-thr", str(CFG.get("joint_risk_thr", 1.0))]
        if isinstance(extra, list):
            cmd += [str(x) for x in extra]
        rc, out, err = run_cli(CLI_AUTH, cmd)
        obj = _parse_stdout_json(out) or {}
        if rc == 2 or not obj:
            return None, (err or out or "融合认证流程失败")
        # 时序窗口不足时明确告警:此时时序层不产生任何约束力,不要误以为它在工作
        if not obj.get("temporal_sufficient", True):
            print(f"[gateway] 时序判定未生效: {obj.get('temporal_note') or '窗口不足'}"
                  f" (clip_span_ms={obj.get('clip_span_ms')}, frames={obj.get('clip_frames')})")
        res = {
            "passed": bool(obj.get("accepted", False)),
            "score": float(obj.get("score", 0.0)),
            "threshold": float(obj.get("threshold", 0.288)),
            "elapsed_ms": float(obj.get("elapsed_ms", 0.0)),
            "reason": obj.get("reason", ""),
            "pad_attack": bool(obj.get("pad_attack", False)),
            "pad_score": float(obj.get("pad_score", 0.0)),
            "temporal_verdict": obj.get("temporal_verdict", ""),
            "temporal_policy": obj.get("temporal_policy", policy),
            "temporal_risk": float(obj.get("temporal_risk", 0.0) or 0.0),
            "temporal_sufficient": bool(obj.get("temporal_sufficient", True)),
            "clip_span_ms": int(obj.get("clip_span_ms", 0) or 0),
            "temporal_note": obj.get("temporal_note", ""),
            "use_blink": bool(obj.get("use_blink", False)),
            "frozen": bool(obj.get("frozen", False)),
            # 模块二×模块三 融合分与联合判据结果:上层决策与标定都依赖这两个数
            "combined_risk": float(obj.get("combined_risk", 0.0) or 0.0),
            "joint_reject": bool(obj.get("joint_reject", False)),
            "blink_count": int(obj.get("blink_count", 0) or 0),
        }
        # 一行式记录本次融合认证的全部分值。CLI 的 stdout 不会进日志,没有这行的话
        # 想看模块二/模块三的分数就只能开浏览器 DevTools 抓响应;标定时很不方便。
        print(f"[gateway] auth {username}: passed={res['passed']} "
              f"score={res['score']:.3f} elapsed={res['elapsed_ms']:.0f}ms | "
              f"pad={res['pad_score']:.2f}/{res['pad_attack']} "
              f"temporal={res['temporal_verdict']}(risk={res['temporal_risk']:.0f},"
              f"policy={res['temporal_policy']},blink_used={res['use_blink']}) "
              f"combined={res['combined_risk']:.2f}/{res['joint_reject']} | "
              f"span={res['clip_span_ms']}ms frames={obj.get('clip_frames')} "
              f"blink={res['blink_count']} frozen={res['frozen']}")
        return res, None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

# ---------- 统一入口:优先常驻 worker,失败回退 CLI ----------

def _register_features(username, img_paths):
    if _worker_ok:
        req = "register %s %d %s" % (username, len(img_paths), " ".join(img_paths))
        obj = _worker_exchange(req)
        if obj is not None:
            if not obj.get("ok"):
                return None, obj.get("error", "注册失败")
            return {"user_id": obj.get("user_id"),
                    "sampleCount": obj.get("stored_samples", len(img_paths))}, None
    return _register_features_cli(username, img_paths)


def _verify_features(username, img_path):
    if _worker_ok:
        obj = _worker_exchange("verify %s %s" % (username, img_path))
        if obj is not None:
            if not obj.get("ok"):
                return None, obj.get("error", "认证失败(可能该账号尚未录入人脸)")
            return {"passed": bool(obj.get("accepted", False)),
                    "score": float(obj.get("score", 0.0)),
                    "threshold": float(obj.get("threshold", 0.288)),
                    "spoof": False,
                    "elapsedMs": float(obj.get("elapsed_ms", 0.0)),
                    "message": ""}, None
    return _verify_features_cli(username, img_path)


def _compare_features(imgA, imgB):
    if _worker_ok:
        obj = _worker_exchange("compare %s %s" % (imgA, imgB))
        if obj is not None:
            if not obj.get("ok"):
                return None, obj.get("error", "比对失败:可能某张图未检出人脸")
            return {"score": float(obj.get("score", 0.0)),
                    "threshold": float(obj.get("threshold", 0.288)),
                    "same": bool(obj.get("same", False)),
                    "elapsedMs": float(obj.get("elapsed_ms", 0.0))}, None
    return _compare_features_cli(imgA, imgB)


def _save_images(data_urls):
    d = Path(tempfile.mkdtemp(prefix="gateway_face_", dir=str(SERVER_DIR)))
    paths = []
    try:
        for i, u in enumerate(data_urls):
            raw = decode_data_url(u)
            if not raw:
                raise ValueError("人脸图片 dataURL 格式错误")
            p = d / f"sample_{i}.jpg"
            p.write_bytes(raw)
            paths.append(str(p))
        return paths, d
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise


# ---------------- API 处理 ----------------

def api_dispatch(handler, method, path, body):
    if isinstance(body, dict) and "_token" not in body:
        body["_token"] = handler.headers.get("X-Admin-Token") or ""
    routes = {
        ("POST", "/api/v1/auth/register"): handle_register,
        ("POST", "/api/v1/auth/login"): handle_login,
        ("POST", "/api/v1/face/enroll"): handle_enroll,
        ("POST", "/api/v1/face/verify"): handle_verify,
        ("POST", "/api/v1/face/compare"): handle_compare,
        ("POST", "/api/v1/security/events"): handle_security_report,
        ("GET", "/api/v1/security/events"): handle_security_list,
        ("GET", "/api/v1/security/export"): handle_security_export,
        ("POST", "/api/v1/admin/register"): handle_admin_register,
        ("POST", "/api/v1/admin/login"): handle_admin_login,
        ("GET", "/api/v1/admin/users"): handle_admin_users,
        ("GET", "/api/v1/health"): handle_health,
    }
    fn = routes.get((method, path))
    if not fn:
        send_json(handler, json_err(404, f"接口不存在: {method} {path}"), http=404)
        return
    try:
        send_json(handler, fn(body))
    except FileNotFoundError as e:
        send_json(handler, json_err(503, str(e)))
    except Exception as e:  # noqa: BLE001
        print(f"[gateway] {path} 异常: {e!r}")
        send_json(handler, json_err(500, "服务器内部错误,请查看网关日志"))


def handle_health(body):
    return json_body({"status": "ok", "backend": "faceauth", "api": "/api/v1"})



# ---------------- 管理端接口 ----------------

def handle_admin_register(body):
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    display = (body.get("displayName") or username).strip()
    if not username or not password:
        return json_err(400, "用户名和密码不能为空")
    # 加固:仅首个管理员可自由注册;之后需 config 的 admin_reg_key 邀请密钥
    try:
        n = _admin_count()
    except Exception as e:  # noqa: BLE001
        return json_err(500, "服务器内部错误:" + str(e))
    if n > 0:
        key = (body.get("key") or "").strip()
        want = str(CFG.get("admin_reg_key") or "")
        if not want:
            return json_err(403, "管理员注册已关闭(需在 config 配置 admin_reg_key)")
        if not hmac.compare_digest(key, want):
            return json_err(403, "邀请密钥不正确")
    acc, err = new_admin(username, display, password)
    if err:
        return json_err(409, err)
    return json_body({"username": acc["username"], "displayName": acc["displayName"]})


def handle_admin_login(body):
    username = (body.get("username") or "").strip()
    acc, err = check_admin(username, body.get("password") or "")
    if err:
        return json_err(401, err)
    tok, ttl = _issue_admin_token(acc["username"])
    acc["token"] = tok
    acc["expiresIn"] = ttl
    return json_body(acc)


def handle_admin_users(body):
    who = _admin_token_ok((body or {}).get("_token") or "")
    if not who:
        return json_err(401, "未授权:请先登录管理员")
    users, err = list_registered_users()
    if err:
        return json_err(500, err)
    return json_body({"count": len(users), "users": users})

# ---------------- 安全告警事件(需求7,落 security_events) ----------------

def _sec_insert_event(evt):
    """插入一条安全事件到 security_events"""
    conn = _db()
    try:
        detail = evt.get("detail")
        if detail is not None and not isinstance(detail, str):
            detail = json.dumps(detail, ensure_ascii=False)
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO security_events"
                "(event_type, username, challenge_id, channel, decision, score, detail, client) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    str(evt.get("event_type", "event"))[:40],
                    str(evt.get("username", "-"))[:64],
                    str(evt.get("challenge_id", ""))[:64],
                    str(evt.get("channel", "frontend"))[:16],
                    str(evt.get("decision", "watch"))[:16],
                    evt.get("score"),
                    detail,
                    str(evt.get("client", ""))[:255] or None,
                ),
            )
        return True
    finally:
        conn.close()


def handle_security_report(body):
    """POST /api/v1/security/events —— 前端把一次活体/防伪事件上报落库"""
    if not body:
        return json_err(400, "空事件")
    try:
        _sec_insert_event(body)
    except Exception as e:  # noqa: BLE001
        print("[gateway] security insert 失败:", repr(e))
        return json_err(500, "告警写入失败:" + str(e))
    return json_body({"ok": True})


def handle_security_list(body):
    """GET /api/v1/security/events —— 最近事件(默认200条)"""
    conn = _db()
    try:
        limit = int(body.get("limit", 200) if isinstance(body, dict) else 200)
        limit = min(max(limit, 1), 500)
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, event_type, username, challenge_id, channel, decision, score,"
                " detail, client, created_at FROM security_events"
                " ORDER BY id DESC LIMIT %s", (limit,))
            rows = cur.fetchall()
        cols = ["id", "event_type", "username", "challenge_id", "channel",
                "decision", "score", "detail", "client", "created_at"]
        events = [dict(zip(cols, r)) for r in rows]
        for e in events:
            for k in list(e):
                e[k] = _json_safe(e[k])
            if e.get("detail"):
                try:
                    e["detail"] = json.loads(e["detail"])
                except Exception:
                    pass
        return json_body({"count": len(events), "events": events})
    finally:
        conn.close()


def handle_security_export(body):
    """GET /api/v1/security/export —— 全部事件(导出用)"""
    conn = _db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, event_type, username, challenge_id, channel, decision, score,"
                " detail, client, created_at FROM security_events ORDER BY id ASC")
            rows = cur.fetchall()
        cols = ["id", "event_type", "username", "challenge_id", "channel",
                "decision", "score", "detail", "client", "created_at"]
        events = [dict(zip(cols, r)) for r in rows]
        for e in events:
            for k in list(e):
                e[k] = _json_safe(e[k])
            if e.get("detail"):
                try:
                    e["detail"] = json.loads(e["detail"])
                except Exception:
                    pass
        return json_body({"count": len(events), "events": events})
    finally:
        conn.close()


def handle_register(body):
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    display = (body.get("displayName") or username).strip()
    samples = body.get("faceSamples") or []
    liveness = body.get("liveness")

    if len(samples) < 1:
        return json_err(400, "未收到人脸样本")
    if not re.fullmatch(r"[A-Za-z0-9_]{4,20}", username):
        return json_err(400, "账号需为 4-20 位字母/数字/下划线")

    # 1) 静态介质预检(faceauth_pad)
    try:
        paths, tmp = _save_images(samples)
    except ValueError as e:
        return json_err(400, str(e))
    try:
        for p in paths:
            pad = _pad_check(p)
            if pad and pad.get("is_attack"):
                audit("register", username,
                      {"decision": "reject",
                       "pad_attack": pad.get("attack_score"),
                       "pad_reason": pad.get("reason")})
                return json_err(403, "采集样本疑似照片/屏幕等静态介质,请真人出镜")
        feat, err = _register_features(username, paths)
        if err:
            return json_err(500, f"人脸特征注册失败: {err}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # 2) 保存账号口令(web_accounts)
    acc, err = new_account(username, display, password)
    if err:
        return json_err(409, err)  # 口令表冲突(特征可能已写入,属少见竞态)
    audit("register", username, {"liveness": liveness, "samples": len(samples), "feature": feat})
    return json_body({"username": acc["username"], "displayName": acc["displayName"],
                      "sampleCount": feat.get("sampleCount")})


def handle_login(body):
    username = (body.get("username") or "").strip()
    acc, err = check_account(username, body.get("password") or "")
    if err:
        return json_err(401, err)
    audit("login", username, {"phase": "password-ok"})
    return json_body(acc)


def handle_enroll(body):
    username = (body.get("username") or "").strip()
    samples = body.get("samples") or body.get("faceSamples") or []
    if len(samples) < 1:
        return json_err(400, "未收到人脸样本")
    # 账号需已存在口令(说明是本人操作)
    conn = _db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM web_accounts WHERE username=%s", (username,))
            if cur.fetchone()[0] == 0:
                return json_err(401, "账号不存在,请先注册")
    finally:
        conn.close()
    try:
        paths, tmp = _save_images(samples)
    except ValueError as e:
        return json_err(400, str(e))
    try:
        for p in paths:
            pad = _pad_check(p)
            if pad and pad.get("is_attack"):
                audit("enroll", username,
                      {"decision": "reject",
                       "pad_attack": pad.get("attack_score"),
                       "pad_reason": pad.get("reason")})
                return json_err(403, "样本疑似照片/屏幕等静态介质,请真人出镜")
        feat, err = _register_features(username, paths)
        if err:
            return json_err(500, f"追加样本失败: {err}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    audit("enroll", username, {"samples": len(samples), "liveness": body.get("liveness")})
    return json_body({"username": username, "sampleCount": feat.get("sampleCount")})


def handle_verify(body):
    username = (body.get("username") or "").strip()
    liveness = body.get("liveness")
    frames = body.get("frames")
    image = body.get("image")

    # 新:多帧融合认证
    if isinstance(frames, list) and frames:
        res, err = _run_auth_cli(username, frames)
        if err:
            audit("verify", username, {"liveness": liveness, "decision": "error", "reason": err})
            return json_err(400, err)
        audit("verify", username,
              {"liveness": liveness,
               "decision": "pass" if res["passed"] else "reject",
               "score": res["score"],
               "pad_attack": res["pad_attack"],
               "temporal_verdict": res["temporal_verdict"]})
        return json_body(res)

    # 旧:单图(保留原逻辑,含 pad 预检)
    if not image:
        return json_err(400, "缺少现场人脸图或 frames")
    try:
        paths, tmp = _save_images([image])
    except ValueError as e:
        return json_err(400, str(e))
    try:
        pad = _pad_check(paths[0])
        if pad and pad.get("is_attack"):
            audit("verify", username,
                  {"liveness": liveness, "decision": "reject",
                   "pad_attack": pad.get("attack_score"),
                   "pad_reason": pad.get("reason")})
            return json_err(403, "检测到照片/屏幕等静态介质,请真人出镜")
        res, err = _verify_features(username, paths[0])
        if err:
            audit("verify", username, {"liveness": liveness, "decision": "error", "reason": err})
            return json_err(400, err)
        audit("verify", username,
              {"liveness": liveness, "decision": "pass" if res["passed"] else "reject",
               "score": res["score"]})
        return json_body(res)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def handle_compare(body):
    """两张人脸图直接比对(不走账号):优先常驻 worker,回退 faceauth_compare2"""
    a = body.get("imageA")
    b = body.get("imageB")
    if not a or not b:
        return json_err(400, "请同时提供 imageA 与 imageB 两张人脸图")
    try:
        paths, tmp = _save_images([a, b])
    except ValueError as e:
        return json_err(400, str(e))
    try:
        res, err = _compare_features(paths[0], paths[1])
        if err:
            return json_err(400, err)
        audit("compare", "-", {"decision": "same" if res["same"] else "diff", "score": res["score"]})
        return json_body(res)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------- 静态文件 ----------------

def serve_static(handler, path):
    if path in ("", "/"):
        rel = "index.html"
    else:
        rel = path.lstrip("/")
    try:
        p = _res(rel)
    except (ValueError, OSError):
        p = None
    if not p or not p.is_file():
        handler.send_response(404)
        handler._cors()
        handler.send_header("Content-Type", "text/plain; charset=utf-8")
        handler.send_header("Content-Length", "9")
        handler.end_headers()
        handler.wfile.write(b"404 Not Found")
        return
    ext = p.suffix.lower()
    ctype = MIME.get(ext, "application/octet-stream")
    data = p.read_bytes()
    handler.send_response(200)
    handler._cors()
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-cache")
    handler.end_headers()
    handler.wfile.write(data)


# ---------------- HTTP handler ----------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FaceAuthGateway/0.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            obj = json.loads(raw.decode("utf-8"))
            return obj if isinstance(obj, dict) else {}
        except json.JSONDecodeError:
            raise ValueError("JSON 解析失败")

    def _handle_api(self, method):
        try:
            body = self._read_json() if method == "POST" else {}
        except ValueError as e:
            send_json(self, json_err(400, str(e)))
            return
        path = urlparse(self.path).path
        api_dispatch(self, method, path, body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self._handle_api("GET")
        else:
            serve_static(self, path)

    def do_HEAD(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self._handle_api("GET")
        else:
            serve_static(self, path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self._handle_api("POST")
        else:
            send_json(self, json_err(404, "POST 仅支持 /api/*"), http=404)

    def log_message(self, fmt, *args):  # 精简访问日志
        sys.stderr.write("[gateway] %s - %s\n" % (self.address_string(), fmt % args))


def main():
    if not WEB_ROOT.is_dir():
        sys.exit(f"[gateway] 前端目录不存在: {WEB_ROOT} (web_root 配置为 {CFG['web_root']})")
    print(f"[gateway] 前端目录  : {WEB_ROOT}")
    print(f"[gateway] faceauth  : {FACE_ROOT}  (CLI: {CLI_REGISTER.name} / {CLI_VERIFY.name})")
    print(f"[gateway] 审计日志  : {AUDIT_PATH}")
    _worker_start()          # 尝试启动常驻模型 worker(提速;失败自动回退 CLI)
    host, port = CFG["host"], int(CFG["port"])
    httpd = ThreadingHTTPServer((host, port), Handler)

    scheme = "http"
    if tls_available():
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile=str(CERT_FILE), keyfile=str(KEY_FILE))
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
            scheme = "https"
            print(f"[gateway] TLS 已启用(证书: {CERT_FILE.name})")
        except Exception as e:
            print(f"[gateway] TLS 启用失败,回退 HTTP: {e!r}")

    print(f"[gateway] 服务已启动: {scheme}://{host}:{port}/   (Ctrl+C 停止)")
    if scheme == "https":
        print("[gateway] 提示:自签证书浏览器会警告,点“高级→继续访问”;生产请换正式证书。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[gateway] 已停止")
        httpd.server_close()
        _worker_stop()


if __name__ == "__main__":
    main()
