/**
 * 人脸图像质量评估(quality.js)
 *
 * 定位:录入时的第一道筛子,对【正脸】进行 8 项依次校验。
 * 任一不达标即返回该项对应的「要求」,拍摄端据此拦截并提示用户调整。
 *
 * 校验顺序(依次短路,先廉价、后读像素):
 *   1) 检测置信度  2) 一帧多人  3) 人脸大小  4) 人脸居中
 *   5) 姿态角     6) 睁眼     7) 模糊度   8) 曝光(过曝/欠曝)
 *
 * 对外只暴露一个函数:
 *   checkEnrollmentQuality(video, m)
 *     -> { ok, failed:{key,label,requirement}, checks:[{key,label,pass,value}] }
 *   失败时 failed 为【第一个】未通过的项;checks 记录到失败为止已评估的项,供逐条显示。
 *
 * 注意:姿态角为 68 点近似角度(度),后端 C++ 侧 solvePnP 真角度由队友标定;
 *       模糊/曝光阈值集中在 config.js 的 CFG.QUALITY,需真机标定。
 */
import { CFG } from './config.js';

// 图像源宽高:兼容 <video> / <img> / <canvas>
const _vw = (el) => el.videoWidth || el.naturalWidth || el.width || 0;
const _vh = (el) => el.videoHeight || el.naturalHeight || el.height || 0;

/**
 * 归一化 yaw/pitch 偏移 → 近似角度(度)。
 * face-engine.js 中 yaw = (鼻尖X - 内眼角中点X)/眼距, pitch 同理,均为无量纲比例;
 * 对二者取 atan 得到近似角度(小角度下比例≈tanθ)。roll 本身已是度。
 */
function poseDegrees(m) {
  const pts = m.landmarks || [];
  const pt = (i) => pts[i] || { x: 0, y: 0 };
  // yaw / roll 复用 face-engine 的归一化值(平视时≈0),直接转角度
  const yawDeg = Math.atan(m.yaw || 0) * 180 / Math.PI;
  const rollDeg = m.roll || 0;
  // pitch 用鼻尖相对「眼睛-嘴巴垂直中点」的偏移:平视时≈0,低头为正/仰头为负。
  // (不能直接复用 m.pitch——那是相对眼睛中心的,平视时鼻尖天然在眼睛下方,会有固定正偏移)
  const eyeCY = (pt(36).y + pt(45).y) / 2;
  const mouthCY = (pt(51).y + pt(57).y) / 2;
  const noseY = pt(30).y;
  const eyeDistX = Math.max(pt(45).x - pt(36).x, 1e-6);
  const midY = (eyeCY + mouthCY) / 2;
  const pitchDeg = Math.atan((noseY - midY) / eyeDistX) * 180 / Math.PI;
  return { yawDeg, pitchDeg, rollDeg };
}

/** 把人脸框区域从视频帧裁剪、缩放到灰度 Float32Array。失败返回 null。 */
function faceGray(video, box, size) {
  const vw = _vw(video), vh = _vh(video);
  if (!vw || !vh || !box) return null;
  let sx = Math.max(0, Math.floor(box.x));
  let sy = Math.max(0, Math.floor(box.y));
  let sw = Math.floor(box.width);
  let sh = Math.floor(box.height);
  if (sx + sw > vw) sw = vw - sx;
  if (sy + sh > vh) sh = vh - sy;
  if (sw < 8 || sh < 8) return null;

  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const gray = new Float32Array(size * size);
  for (let i = 0, o = 0; i < img.data.length; i += 4, o++) {
    gray[o] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  return { gray, size };
}

/** 3×3 拉普拉斯算子响应的方差:清晰图高、模糊图低。 */
function laplacianVariance(gray, size) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - size] - gray[i + size];
      sum += v; sum2 += v * v; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/** 亮度统计:均值 + 过曝/欠曝像素占比(%)。 */
function exposureStats(gray, size, overLevel, underLevel) {
  let sum = 0, over = 0, under = 0;
  const n = size * size;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    sum += v;
    if (v >= overLevel) over++;
    else if (v <= underLevel) under++;
  }
  return { mean: sum / n, overPct: (over / n) * 100, underPct: (under / n) * 100 };
}

/**
 * 8 项校验定义(顺序即校验顺序)。每项的 requirement 是「不达标时显示给用户的要求」。
 * run 返回 { pass, value [, requirement] },value 为该项读数(用于实时显示);
 * 曝光等项可通过 requirement 动态覆盖默认文案。
 * 第三参 gray 是惰性灰度图获取器(仅模糊/曝光两项使用)。
 */
const CHECKS = [
  {
    key: 'score', label: '检测',
    requirement: '未识别到人脸，请重拍',
    run(video, m) {
      const pass = m.score >= CFG.QUALITY.detect.minScore;
      return { pass, value: (m.score || 0).toFixed(2) };
    },
  },
  {
    key: 'multi', label: '人数',
    requirement: '请确保屏幕中只有单张人脸',
    run(video, m) {
      const n = (m.faceCount != null) ? m.faceCount : 1;
      return { pass: n <= CFG.QUALITY.face.maxFaceCount, value: n > 1 ? `${n} 人` : '单人' };
    },
  },
  {
    key: 'size', label: '大小',
    requirement: '人脸过小，请重拍',
    run(video, m) {
      const fq = CFG.QUALITY.face;
      const vw = _vw(video);
      const b = m.box;
      const faceRatio = vw ? b.width / vw : 0;
      return { pass: faceRatio >= fq.minFaceRatio, value: `${Math.round(faceRatio * 100)}%` };
    },
  },
  {
    key: 'center', label: '居中',
    requirement: '请将人脸放在屏幕中间',
    run(video, m) {
      const vw = _vw(video), vh = _vh(video);
      const b = m.box;
      const side = Math.min(vw, vh);
      const cropX = (vw - side) / 2, cropY = (vh - side) / 2;
      const insideCrop = vw > 0 && vh > 0 &&
        b.x >= cropX - 1 && b.y >= cropY - 1 &&
        (b.x + b.width) <= cropX + side + 1 && (b.y + b.height) <= cropY + side + 1;
      return { pass: insideCrop, value: insideCrop ? '居中' : '偏' };
    },
  },
  {
    key: 'pose', label: '姿态',
    requirement: '请正对镜头，保持头部端正',
    run(video, m) {
      const pd = poseDegrees(m);
      const pp = CFG.QUALITY.pose;
      const pass = Math.abs(pd.rollDeg) <= pp.maxRollDeg &&
        Math.abs(pd.pitchDeg) <= pp.maxPitchDeg &&
        Math.abs(pd.yawDeg) <= pp.maxYawDeg;
      return { pass, value: `y${Math.round(pd.yawDeg)}° p${Math.round(pd.pitchDeg)}° r${Math.round(pd.rollDeg)}°` };
    },
  },
  {
    key: 'eye', label: '睁眼',
    requirement: '请睁开双眼',
    run(video, m) {
      const pass = m.ear >= CFG.QUALITY.eye.minEar;
      return { pass, value: `EAR ${m.ear.toFixed(2)}` };
    },
  },
  {
    key: 'blur', label: '清晰',
    requirement: '图片模糊，请重拍',
    run(video, m, gray) {
      const fg = gray();
      if (!fg) return { pass: true, value: '-' };   // 读像素失败则不据此拦截
      const lv = laplacianVariance(fg.gray, fg.size);
      return { pass: lv >= CFG.QUALITY.blur.laplacianMin, value: String(Math.round(lv)) };
    },
  },
  {
    key: 'exposure', label: '曝光',
    requirement: '图片太亮，请重拍',   // 默认过曝;欠曝由 run 动态覆盖
    run(video, m, gray) {
      const fg = gray();
      if (!fg) return { pass: true, value: '-' };
      const exp = CFG.QUALITY.exposure;
      const st = exposureStats(fg.gray, fg.size, exp.overLevel, exp.underLevel);
      const over = st.mean > exp.meanMax || st.overPct > exp.overPctMax;
      const under = st.mean < exp.meanMin || st.underPct > exp.underPctMax;
      return {
        pass: !over && !under,
        value: `均${Math.round(st.mean)}`,
        requirement: over ? '图片太亮，请重拍' : under ? '图片太暗，请重拍' : undefined,
      };
    },
  },
];

/**
 * 对正脸依次校验 8 项质量。任一不达标即短路返回,并给出对应要求。
 * @param {HTMLVideoElement} video
 * @param {object} m detectMetrics 的返回(需 m.ok 为 true)
 * @returns {{ok:boolean, failed:?{key:string,label:string,requirement:string},
 *            checks:Array<{key:string,label:string,pass:boolean,value:string}>}}
 */
export function checkEnrollmentQuality(video, m) {
  const out = { ok: false, failed: null, checks: [] };
  if (!m || !m.ok) {
    out.failed = { key: 'face', label: '人脸', requirement: '未识别到人脸，请重拍' };
    return out;
  }

  // 模糊/曝光共用的灰度图,惰性计算(前几项通过才触发读像素)
  let grayCache = null;
  const gray = () => {
    if (grayCache === null) grayCache = faceGray(video, m.box, CFG.QUALITY.sampleSize);
    return grayCache;
  };

  for (const c of CHECKS) {
    const r = c.run(video, m, gray);
    out.checks.push({ key: c.key, label: c.label, pass: r.pass, value: r.value });
    if (!r.pass) {
      out.failed = { key: c.key, label: c.label, requirement: r.requirement || c.requirement };
      return out;
    }
  }
  out.ok = true;
  return out;
}
