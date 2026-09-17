/**
 * 全局配置
 *
 * API_MODE = 'mock'  前端独立演示,数据存 localStorage,识别结果为模拟
 * API_MODE = 'http'  对接网关/后端(Python 网关转发到队友 C++ faceauth)
 * API_MODE = 'auto'  启动探测 /api/v1/health:后端在线→http,否则回退 mock
 *
 * 约定后端接口契约(建议):
 *   POST {API_BASE}{ENDPOINTS.register}   body: {username, password, displayName,
 *                                                 faceSamples:[dataUrl,...],
 *                                                 liveness:{challengeId,passed,actions,platform:'web'}}
 *       -> {code:0, message:"ok", data:{username, displayName}}
 *   POST {API_BASE}{ENDPOINTS.login}      body: {username, password}
 *       -> {code:0, data:{username, displayName, faceRegistered:true}}    // 密码阶段
 *   POST {API_BASE}{ENDPOINTS.faceEnroll} body: {username, samples:[dataUrl,...]}
 *       -> {code:0, data:{templateId, sampleCount}}
 *   POST {API_BASE}{ENDPOINTS.faceVerify} body: {username, image:dataUrl,
 *                                                liveness:{challengeId,passed,actions}}
 *       -> {code:0, data:{passed:true, score:0.963, spoof:false, elapsedMs:523}}
 *
 * 前端只做:人脸检测 + 68 点关键点 + 动作活体挑战,并把活体记录(challengeId)
 * 附带给后端,供审计与告警(需求7)。身份比对(score)以后端返回为准。
 *
 * 错误统一为 {code:非0, message:"错误描述"},HTTP 状态与 code 解耦便于前端处理。
 */
export const CFG = {
  // API_MODE: 'auto' 强制本地模拟;'http' 强制走后端;'auto' 启动时探测
  //   /api/v1/health,后端在(如网关已启动)则 http,否则回退 mock 便于纯前端演示。
  API_MODE: 'auto',
  API_BASE: '/api/v1',   // 网关同源托管时用相对路径;也可填 http://127.0.0.1:8000/api/v1
  ENDPOINTS: {
    register: '/auth/register',
    login: '/auth/login',
    faceEnroll: '/face/enroll',
    faceVerify: '/face/verify',
    compare: '/face/compare',
    securityEvents: '/security/events',
    securityExport: '/security/export',
    adminRegister: '/admin/register',
    adminLogin: '/admin/login',
    adminUsers: '/admin/users',
  },

  // 摄像头 / 采集参数
  CAMERA: {
    // 向浏览器请求的分辨率。2026-09-16 从 640x480 提到 1280x720:
    // 上传帧的分辨率直接决定服务端两个模块的输入质量 —— 模块三的稀疏 KLT
    // 在 320x240 上人脸只有约 100px,可靠纹理点太少、跟踪不稳;模块二的
    // 频域(摩尔纹)与纹理通道也受分辨率限。提高采集分辨率不引入任何拒绝
    // 规则,因此是"零误伤风险"的优化。
    // 若摄像头不支持会由浏览器自动降级,不影响功能。
    width: 1280,
    height: 720,
    facingMode: 'user',        // 前置摄像头
    // 上传帧最长边(px)。320 → 640 约提升 2 倍线性分辨率(4 倍像素)。
    // 体积:约 64 帧 × 60~80KB ≈ 4~5MB(base64 后 ~6MB),在网关
    // max_body_mb(默认 20)之内。若隧道带宽吃紧可降到 480。
    UPLOAD_MAX_SIDE: 640,
    // 摄像头界面铺满浏览器窗口(不调用 Fullscreen API)。
    // 预览框跟随摄像头实际宽高比居中最大化(不再写死 4:3,否则视频被
    // object-fit:cover 裁切而叠加层按视频像素拉伸,68 点会错位);
    // 色光检测的闪光层挂在弹窗上,可覆盖整个窗口。
    WINDOW_FULLSCREEN: true,
    sampleSize: 224,           // 人脸样本裁剪边长(px);识别 112 即可,小点传输更快
    jpegQuality: 0.68,
    motionIntervalMs: 220,     // 画面活动检测采样间隔
    motionThreshold: 1.6,      // 帧间灰度差阈值(判定“画面有活动”)

    // —— 时序活体观察窗(配合服务端模块三 mod3)——
    // 认证时先采一段正面帧用于比对,再追加一段「静息」序列供服务端做时序判定。
    // 模块三的冻结判据要求运动能量极低(<0.20 px/帧)、眨眼判据需要 ≥4s 窗口与
    // ≥25 个带点样本,因此这段窗口必须基本静止;帧太短服务端会如实标 INSUFFICIENT。
    TEMPORAL: {
      enabled: true,
      windowMs: 5000,          // 静息观察时长(ms);建议 4000~6000,需 ≥ 服务端 min-window-ms
      fps: 10,                 // 采样率(帧/秒);服务端 mod3 默认按 ~10fps 对齐(flowStep=1)
      maxYaw: 0.35,            // 允许的头部偏转;比比对帧(0.18)宽松,避免轻微晃动就丢帧
      maxSide: 640,            // 观察窗帧最长边;留空/删掉则取 CAMERA.UPLOAD_MAX_SIDE
    },
  },

  // 采集姿势步骤
  POSES: {
    enroll: [
      { key: 'front', label: '正面平视' },
      { key: 'left',  label: '轻微向左转头' },
      { key: 'right', label: '轻微向右转头' },
    ],
    verify: [
      { key: 'front', label: '请正对摄像头' },
    ],
  },

  // 人脸关键点引擎(face-api.js @vladmandic/face-api,68点,与 dlib/Facemark-LBF 同点序)
  // 加载策略:优先本地 assets/(离线部署,用 tools/fetch_assets.py 预下载),失败自动回退 CDN。
  FACE: {
    LIB_URIS: [
      './assets/vendor/face-api.min.js',
      'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.min.js',
      'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.js',
    ],
    MODEL_URIS: [
      './assets/models',
      'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model',
    ],
    DETECT_OPTS: { inputSize: 224, scoreThreshold: 0.5 },
    DRAW_OVERLAY: true,
    // 人脸占画面宽度比例下限,过小/过远不参与活体判定
    MIN_FACE_RATIO: 0.12,
  },

  // 动作活体挑战(防照片 / 防视频重放的第一层,后端可再叠加纹理/光流/深度判定)
  LIVENESS: {
    randomize: true,             // 动作随机排序,增强防重放
    perActionTimeoutMs: 12000,   // 单动作最长等待
    noFaceGraceMs: 4000,         // 挑战期间连续无人脸超过该时长→失败
    actions: {
      enroll: ['shake_head', 'nod', 'open_mouth'],
      verify: ['shake_head', 'nod', 'open_mouth'],
    },
    // 验证随机抽 2 个动作(不是 1 个),注册抽满 3 个
    pickCount: { enroll: 3, verify: 2 },
    labels: {
      blink: '请眨一下眼睛',
      open_mouth: '请张开嘴巴',
      shake_head: '请左右摇头',
      nod: '请点一下头',
    },
    // —— 眨眼自适应判定(核心改进) ——
    // 不再用固定闭眼阈值,而是按每个人“睁眼基线 EAR”动态计算闭眼阈值,
    // 避免单眼皮/小眼/戴眼镜者基线偏低时永远检测不到眨眼。
    eyeHistoryMs: 800,           // 用于估计睁眼基线的时间窗口
    eyeBaseFloor: 0.20,          // 睁眼基线下限(防半眯噪声把基线拉低)
    eyeBaseCap: 0.45,            // 睁眼基线上限
    eyeClosedFactor: 0.70,       // 闭眼阈值 = min(基线×factor, 基线-offset)
    eyeClosedOffset: 0.085,
    eyeClosedFloor: 0.28,        // 闭眼阈值绝对下限
    eyeOpenRecover: 0.88,        // 睁回阈值 = 基线×recover
    blinkMinClosedMs: 30,        // 最短闭眼时间(太短视为噪声)
    blinkMaxClosedMs: 1500,      // 超过该时长视为长时间闭眼,不算自然眨眼
    // 嘴部开合 / 头部姿态
    mouthOpenMar: 0.38,          // MAR(嘴上下/嘴角宽)高于该值视为张嘴
    turnAbs: 0.30,               // 左右转头 |yaw| 幅度
    nodAbs: 0.24,                // 点头纵向幅度
    // —— 静止门控(独立于眨眼参数,不改动上面阈值)——
    // 眨眼/张嘴需要人脸基本静止才可靠。检测到人脸整体晃动明显时,
    // 自动暂停该两项的判定(不累计判定、不误触发),并提示保持静止。
    motionGate: {
      armMs: 400,          // 指令后需先静止该时长才开始计数(防连续播放/循环视频)
      enabled: true,
      // 摇头/点头本身要动,不受门控。
      // 注意:'blink' 写在里面是预留 —— 当前 enroll/verify 两个动作池都没有 blink,
      // 所以这个门控实际只作用于 open_mouth(眨眼那套阈值在验证流程里未被使用)。
      applyTo: ['blink', 'open_mouth'],
      moveRatio: 0.07,    // 相邻帧人脸中心位移 ÷ 脸宽,超过即判定“在晃动”
      scaleRatio: 0.12,   // 相邻帧脸宽变化率超限(靠近/远离)也判为晃动
      rollAbsDeg: 3,     // 人脸倾斜角 |roll| 超过该值(歪头)也暂停眨眼/张嘴判定
      maxDtMs: 300,       // 只在两帧间隔小于该值时才做位移判断
      absoluteCapFactor: 3, // 单个动作的绝对时长上限 = 超时 × 该系数(防无限暂停)
    },
  },

  // —— 纯前端安全增强(需求 4-7) ——
  // 三个门控(屏闪反射 / 局部形变 / 姿态跳变)默认只出软信号与告警,不阻断认证。
  SECURITY: {
    enabled: true,               // 总开关
    // 门控总开关。各门控自己还有 enforceGate,只有两者都为真才硬拦。
    // 当前:色光反射 = 硬拦(true),局部形变 = 只告警(false)。
    // 依据:实测手机翻拍时,色光通道两次都报了 screen_reflect(suspicious),
    // 而模块二(static_media)在 320×240+JPEG 下对翻拍基本失效(attack_score≈0.17)、
    // 模块三(光流)对"会动会眨眼的屏幕"天然无效——所以色光是目前唯一能拦翻拍的层。
    // 局部形变的 minRatio 仍是经验值且未标定,先维持只告警,避免误拒。
    enforceGates: true,
    screenReflect: true,         // 屏幕反射挑战(针对“用屏幕播视频/照片”)
    localDeform: true,           // 眼/嘴局部形变一致性(针对打印照片/贴纸盖脸)
    poseContinuity: true,        // 头部姿态轨迹平滑性(针对 3D 面具/照片活化)
    flashMs: 320,                // 屏闪时长(毫秒,预留)
      reflect: {
      boost: 6,                  // (保留,调试参考)绝对通道增强
      // 通道选择性阈值:打某色时"该色抬升量 − 另两色平均抬升量"。实测(2026-09-15):
      // 真人 avgSel=12.21;手机翻拍 avgSel ≤1.91(−0.37 / 0.54 / 1.91)。原值 1.5 离
      // 翻拍峰值只有 0.4 余量,太薄,故提到 3.0 —— 真人侧仍有 4 倍余量。
      selectivityThr: 3.0,
      // 判据分两层:先看「有没有测到」(avgBoost ≥ 该值才算测到),再看通道选择性。
      // 否则测量失败(打光没打到脸/采样区偏了)时 avgBoost≈0、avgSel 也≈0,
      // 会被当成「屏幕」误拒真人——实测出现过 avgBoost=0.1 判 suspicious 的记录。
      boostFloor: 1.0,
      sampleFraction: 0.5,       // 采样区占脸比
      perColorMs: 300,           // 每色总时长(含 settle)
      settleMs: 150,             // 闪色后等稳定再采样(ms)
      samplesPerColor: 3,        // 每色连采帧数,取中位
      sampleGapMs: 60,           // 每帧采样间隔(ms)
      // 单项目开关:仅当顶层 enforceGates=true 时才生效(默认 false=只告警)
      enforceGate: true,
      tries: 2,
      // —— 中央椭圆挖洞:除椭圆外整屏闪光,光强集中、抗屏幕反光干扰 ——
      ellipseWRatio: 0.46,       // 椭圆宽 = 窗口宽 × 该值
      ellipseHRatio: 0.66,       // 椭圆高 = 窗口高 × 该值
      ellipseFeather: 0.06,      // 椭圆边缘羽化(占半径比例),避免硬边影响采样
      insideMargin: 0.06,        // 人脸中心须落在椭圆内、并留出该比例余量才算对准
      alignTries: 6,             // 测量失败(未对准 / 无响应)的最大重试次数,每次约 0.6s
      // 反复没测成时的策略,两者可分别配置(性质不同):
      //   onAlignFail  人脸没进中央椭圆 —— 姿势问题,可能只是用户不会站位
      //   onNoResponse 打光后目标通道无抬升 —— 更可疑,重放时画面在变,差分测量易失效
      // 'reject' = 拒绝本次认证;'skip' = 跳过色光检测继续(不引入误拒,但留了绕过口子)
      // 默认都 reject:实测有翻拍样例靠"测量失败"绕过了这道防线(id 229 verify_pass +
      // reflect_skipped/no-response)。若真人在光线差时被大量误拒,再把 onAlignFail 调回 skip。
      onAlignFail: 'reject',
      onNoResponse: 'reject',
    },
    // ROI形变/全脸形变 低于该值→可疑。enforceGate 保持 false:阈值未标定,
    // 且戴口罩/刘海/低分辨率都会拉低形变比,先只告警不阻断。
    deform: { minRatio: 0.28, enforceGate: false },
    pose: { maxJump: 0.45, maxRollDeg: 28, minSamples: 5 }, // 相邻帧姿态最大跳变(归一化);摇头属正常运动需放宽
    persistLocal: true,          // 后端离线时也把告警存 localStorage(演示兜底)
  },

  // —— 人脸图像质量评估(录入/采集第一道筛子,纯前端)——
  // 采样阶段实时计算并显示;拍摄时任一指标不达标则拦截、提示重拍。
  // 模糊度用拉普拉斯方差(越高越清晰);曝光用亮度均值+过曝/欠曝像素占比;
  // 姿态角为 68 点近似角度(度),后端 solvePnP 真角度由队友在 C++ 侧标定。
  QUALITY: {
    enabled: true,               // 总开关:false 则关闭质量拦截与显示
    intervalMs: 400,             // 采样阶段质量计算的节流间隔(模糊/曝光需读像素,不宜每帧算)
    sampleSize: 64,              // 人脸区灰度图边长(px),用于模糊/曝光计算
    blur: {
      laplacianMin: 12,          // 拉普拉斯方差低于该值判定为模糊(需在真机标定,见 debug 页思路)
    },
    exposure: {
      meanMin: 40,               // 人脸平均亮度低于该值→欠曝
      meanMax: 215,              // 人脸平均亮度高于该值→过曝
      overLevel: 245,            // 判定过曝的灰度阈值
      underLevel: 15,            // 判定欠曝的灰度阈值
      overPctMax: 30,            // 过曝像素占比(%)超限→过曝
      underPctMax: 30,           // 欠曝像素占比(%)超限→欠曝
    },
    pose: {
      maxYawDeg: 12,             // 正面允许的最大左右偏角(度)
      maxPitchDeg: 15,           // 最大俯仰角(度)
      maxRollDeg: 12,            // 最大倾斜角(度)
      turnYawMinDeg: 12,         // 左/右转头姿态的最小偏角(至少转到该角度才有效)
      turnYawMaxDeg: 40,         // 左/右转头姿态的最大偏角(避免过度转头)
    },
    eye: {
      minEar: 0.20,              // 平均 EAR 低于该值判定为闭眼(录入要求睁眼,避免把闭眼帧入库)
    },
    detect: {
      minScore: 0.60,            // 检测置信度低于该值判定为不可靠(建议重拍)
    },
    face: {
      minFaceRatio: 0.15,        // 人脸占画面宽比下限(过小/过远则拒)
      maxFaceCount: 1,           // 画面中允许的最大人脸数(>1 判多人入镜)
    },
  },

  // 演示账号
  DEMO: { username: 'demo', password: 'Demo@1234', displayName: '演示用户' },
};

/** 模拟识别是否开启(仅 mock 模式生效)。true 表示前端独立演示通过。 */
export const SIMULATED_FACE_VERIFY = true;
