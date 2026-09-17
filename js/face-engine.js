/**
 * 人脸关键点引擎(face-engine.js)
 *
 * 在浏览器内实现与人脸关键点检测——等价于参考项目
 * (amusi/opencv-facial-landmark-detection,OpenCV Facemark-LBF / dlib 68点方案)。
 * 底层使用 face-api.js(@vladmandic/face-api,纯前端推理),检测网络 tinyFaceDetector
 * + 68 点关键点网络 FaceLandmark68Net,点序与 dlib 完全一致。
 *
 * 职责:
 *   - 动态加载 face-api(本地 assets/ 优先,CDN 兜底)并加载模型;
 *   - 对摄像头视频帧检测人脸,输出 68 点 + 面框 + 检测质量;
 *   - 由 68 点推算几何指标:
 *       EAR  眼部纵横比(左/右/平均)      —— 用于眨眼检测
 *       MAR  嘴部开合比                    —— 用于张嘴检测
 *       yaw  水平转头归一化偏移            —— 用于摇头检测
 *       pitch 纵向归一化偏移               —— 用于点头检测
 *   - drawOverlay():把面框与 68 点叠加绘制到镜像预览画面。
 *
 * 注意:人脸比对(身份)不在本模块做,交由后端 /api/v1/face/verify。
 */
import { CFG } from './config.js';

/* ----------------------------- 68 点索引 ----------------------------- */
const L_EYE = [36, 37, 38, 39, 40, 41];
const R_EYE = [42, 43, 44, 45, 46, 47];
const OUTER_MOUTH = { l: 48, top: 51, r: 54, bottom: 57 };
const NOSE_TIP = 30;
const CHIN = 8;

const _pt = (p, i) => ({ x: p[i].x, y: p[i].y });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function earOf(points, idx) {
  const p0 = _pt(points, idx[0]), p1 = _pt(points, idx[1]);
  const p2 = _pt(points, idx[2]), p3 = _pt(points, idx[3]);
  const p4 = _pt(points, idx[4]), p5 = _pt(points, idx[5]);
  return (dist(p1, p5) + dist(p2, p4)) / (2 * dist(p0, p3) + 1e-6);
}

/* ----------------------------- 引擎状态 ----------------------------- */
let _libPromise = null;      // 加载后的 promise(缓存)
let _modelsLoaded = false;

/** face-api 是否已可用的快速判断 */
export const isFaceApiLoaded = () => !!window.faceapi;

/** 加载并缓存 face-api 库(本地优先,CDN 兜底) */
function loadLib() {
  if (window.faceapi) return Promise.resolve(window.faceapi);
  if (_libPromise) return _libPromise;
  _libPromise = (async () => {
    let lastErr = null;
    for (const uri of CFG.FACE.LIB_URIS) {
      try {
        await injectScript(uri);
        if (window.faceapi) return window.faceapi;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('face-api 库加载失败');
  })();
  return _libPromise;
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error('script 加载失败: ' + src)); };
    document.head.appendChild(s);
  });
}

async function loadModels(fa) {
  let lastErr = null;
  for (const uri of CFG.FACE.MODEL_URIS) {
    try {
      // loadFromUri 读取 <name>-weights_manifest.json 后按清单拉取 .bin
      await fa.nets.tinyFaceDetector.loadFromUri(uri);
      await fa.nets.faceLandmark68Net.loadFromUri(uri);
      _modelsLoaded = true;
      return fa;
    } catch (e) {
      lastErr = e;
      // 该 uri 不可用,重置已加载网络便于下一次完整重试
      try { fa.nets.tinyFaceDetector.isLoaded = false; } catch {}
      try { fa.nets.faceLandmark68Net.isLoaded = false; } catch {}
    }
  }
  throw lastErr || new Error('人脸模型加载失败');
}

/**
 * 确保引擎就绪。onState: 'loading-lib' | 'loading-models' | 'ready' | 'error'
 */
export async function ensureEngine(onState) {
  try {
    onState && onState('loading-lib');
    const fa = await loadLib();
    if (!_modelsLoaded) {
      onState && onState('loading-models');
      await loadModels(fa);
    }
    onState && onState('ready');
    return fa;
  } catch (e) {
    onState && onState('error');
    throw e;
  }
}

/* ----------------------------- 单帧检测 ----------------------------- */
/**
 * 对视频帧做检测与几何指标计算。
 * 返回:
 *   { ok:false, reason:'no-engine'|'no-face'|'too-small'|'error', detail }
 * 或 { ok:true, box, landmarks, leftEAR, rightEAR, ear, mar, yaw, pitch,
 *       score, widthRatio }
 */
export async function detectMetrics(video) {
  const fa = window.faceapi;
  if (!fa || !fa.nets.tinyFaceDetector.isLoaded) return { ok: false, reason: 'no-engine' };

  try {
    const options = new fa.TinyFaceDetectorOptions(CFG.FACE.DETECT_OPTS);
    const results = await fa
      .detectAllFaces(video, options)
      .withFaceLandmarks();   // 默认 FaceLandmark68Net(与 Facemark-LBF 同 68 点序)

    if (!results || !results.length) return { ok: false, reason: 'no-face' };

    // 主脸取面积最大者(避免他人入镜时框错);faceCount 供质量门判断"一帧多人"
    let res = results[0];
    let bestArea = -1;
    for (const r of results) {
      const a = r.detection.box.width * r.detection.box.height;
      if (a > bestArea) { bestArea = a; res = r; }
    }

    const box = res.detection.box;           // {x,y,width,height}
    const pts = res.landmarks.positions;     // Array<{x,y}> 68 点
    const srcW = video.videoWidth || video.naturalWidth || video.width || 0;
    const widthRatio = srcW ? box.width / srcW : 0;
    if (widthRatio < CFG.FACE.MIN_FACE_RATIO) {
      return { ok: false, reason: 'too-small', widthRatio };
    }

    const leftEAR = earOf(pts, L_EYE);
    const rightEAR = earOf(pts, R_EYE);
    const ear = (leftEAR + rightEAR) / 2;

    // 嘴部开合比(MAR)
    const mar =
      dist(_pt(pts, OUTER_MOUTH.top), _pt(pts, OUTER_MOUTH.bottom)) /
      (dist(_pt(pts, OUTER_MOUTH.l), _pt(pts, OUTER_MOUTH.r)) + 1e-6);

    // 头部姿态粗估(归一化,非真实角度;由后端起 3D 标定时替换)
    // —— 退化保护 ——
    // 关键点异常时两眼外眼角会几乎重合,旧代码只把分母兜到 1e-6,于是 yaw/pitch
    // 会爆炸到百万级(实测告警里出现过 maxYaw=1.5e7)。后果有两个:一是 pose_jump
    // 告警被垃圾数据刷屏,二是摇头/点头挑战判的是 yaw 极差,一帧 -1500 万配一帧 +0.4
    // 就能把动作"蒙"过去。所以先按人脸框宽度做合理性检查:正面脸的两眼外眼角间距
    // 通常在脸宽的 0.35~0.5,低于 0.15 倍即认为该帧关键点不可信,整帧丢弃。
    const eyeLX = _pt(pts, 36).x, eyeRX = _pt(pts, 45).x;
    const eyeDistX = eyeRX - eyeLX;
    const minEyeDist = box.width * 0.15;
    if (!Number.isFinite(eyeDistX) || eyeDistX < minEyeDist) {
      return {
        ok: false,
        reason: 'degenerate-landmarks',
        detail: `eyeDist=${eyeDistX} boxW=${box.width} min=${minEyeDist.toFixed(1)}`,
      };
    }
    const innerCX = (_pt(pts, 39).x + _pt(pts, 42).x) / 2;
    const noseX = _pt(pts, NOSE_TIP).x;
    const yaw = (noseX - innerCX) / eyeDistX;

    const eyeCY = (_pt(pts, 36).y + _pt(pts, 45).y) / 2;
    const noseY = _pt(pts, NOSE_TIP).y;
    const pitch = (noseY - eyeCY) / eyeDistX;

    // 面部倾斜角 roll(度):由双眼外眼角连线相对水平的角度估计;歪头时变大
    const eyeLY = _pt(pts, 36).y, eyeRY = _pt(pts, 45).y;
    const roll = (Math.atan2(eyeRY - eyeLY, eyeRX - eyeLX) * 180) / Math.PI;

    return {
      ok: true,
      box,
      landmarks: pts,
      leftEAR,
      rightEAR,
      ear,
      mar,
      yaw,
      pitch,
      roll,
      score: res.detection.score,
      widthRatio,
      faceCount: results.length,
    };
  } catch (e) {
    return { ok: false, reason: 'error', detail: e && e.message };
  }
}

/* ----------------------------- overlay 绘制 ----------------------------- */
const LANDMARK_COLOR = '#7cf7b0';
const EYE_COLOR = '#39d6ff';
const MOUTH_COLOR = '#ff9ad5';
const BOX_COLOR = 'rgba(201,162,39,.95)';

/**
 * 在摄像头预览上绘制面框与 68 点。
 * 假定 ctx 画布尺寸 = 视频帧尺寸(width x height),且画布以 CSS 镜像显示;
 * 内部通过镜像变换让点与预览对齐,文本则逆镜像以保证可读。
 */
export function drawOverlay(ctx, m, width, height) {
  ctx.clearRect(0, 0, width, height);
  if (!m || !m.ok || !CFG.FACE.DRAW_OVERLAY) return;

  // 镜像坐标域绘制几何图形
  ctx.save();
  ctx.translate(width, 0);
  ctx.scale(-1, 1);

  // 面框
  const b = m.box;
  ctx.strokeStyle = BOX_COLOR;
  ctx.lineWidth = 2;
  ctx.strokeRect(b.x, b.y, b.width, b.height);

  // 68 点:外轮廓与眉鼻金色系,眼睛青色,嘴品红
  m.landmarks.forEach((p, i) => {
    const eye = L_EYE.includes(i) || R_EYE.includes(i);
    const mouth = i >= 48 && i <= 67;
    const face = i <= 35;
    ctx.fillStyle = eye ? EYE_COLOR : mouth ? MOUTH_COLOR : face ? LANDMARK_COLOR : '#d8c07a';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.1, 0, Math.PI * 2);
    ctx.fill();
  });

  // 高亮特征连线(眼睛/嘴)
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = EYE_COLOR;
  strokeIdx(ctx, m.landmarks, [...L_EYE, L_EYE[0]]);
  strokeIdx(ctx, m.landmarks, [...R_EYE, R_EYE[0]]);
  ctx.strokeStyle = MOUTH_COLOR;
  const mouthIdx = Array.from({ length: 12 }, (_, k) => 48 + k);
  strokeIdx(ctx, m.landmarks, [...mouthIdx, 48]);

  ctx.restore();

  // 指标文本(正常方向)
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = '12px ui-monospace, SFMono-Regular, Consolas, monospace';
  ctx.fillText(
    `EAR ${m.ear.toFixed(2)}  MAR ${m.mar.toFixed(2)}  yaw ${m.yaw.toFixed(2)}  pitch ${m.pitch.toFixed(2)}  roll ${(m.roll || 0).toFixed(1)}°`,
    10,
    16
  );
}

function strokeIdx(ctx, pts, idxs) {
  ctx.beginPath();
  idxs.forEach((i, k) => {
    const p = pts[i];
    k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
}
