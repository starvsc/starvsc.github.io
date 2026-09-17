/**
 * 纯前端安全增强检测器(spoof-engine.js)
 *
 * 为需求 4~7 提供安全增强“软信号”(只记告警/提示,不负责最终拒绝):
 *   1) 局部形变一致性  —— 针对“打印照片 / 贴纸盖脸”(眨眼/张嘴应带来真实局部形变);
 *   2) 姿态轨迹平滑性  —— 针对“3D 面具 / 照片活化”(轨迹应连续、无跳变);
 *   3) 人脸区 RGB 采样 / 小灰度帧  —— 供调用方做反射与形变测量。
 *
 * 注:屏幕反射(色光)挑战已改为在 camera.js 内实现(整屏闪光 + 中央椭圆挖洞),
 *     本模块不再提供独立的屏闪探测函数。
 *
 * 设计原则:所有函数失败都返回 {done:false},调用方 try/catch 后跳过,
 * 绝不让实验性启发式阻断正常认证。
 */

/** 把一帧视频缩小为灰度 Uint8Array(用于帧差/形变比较) */
export function grayVideo(video, w = 48, h = 36) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < img.data.length; i += 4, o++) {
    out[o] = (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]) | 0;
  }
  return { w, h, data: out };
}

/** 采样人脸框中心 fraction 区域的 RGB 均值 */
export function sampleFaceMeanRgb(video, box, fraction = 0.5) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = Math.min(box.width * fraction, vw);
  const ch = Math.min(box.height * fraction, vh);
  const sx = Math.max(0, Math.min(box.x + (box.width - cw) / 2, vw - cw));
  const sy = Math.max(0, Math.min(box.y + (box.height - ch) / 2, vh - ch));
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, cw, ch, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}

/**
 * 局部形变 / 全脸形变 比值。
 * 两帧灰度(同尺寸)比较:ROI 平均绝对差 ÷ 全脸区域平均绝对差。
 * 真人眨眼/张嘴时 ROI(眼/嘴)变化显著高于刚体晃动残余 → 比值较高;
 * 打印照片/贴纸整体平移时 ROI 与全脸同涨同跌 → 比值偏低。
 */
export function localVsWholeRatio(a, b, roi) {
  if (!a || !b || a.w !== b.w || a.h !== b.h || !roi) return null;
  const { w, h, data: da } = a;
  const db = b.data;
  const rx = Math.max(0, Math.floor(roi.x));
  const ry = Math.max(0, Math.floor(roi.y));
  const rw = Math.min(w - rx, Math.floor(roi.w || roi.width));
  const rh = Math.min(h - ry, Math.floor(roi.h || roi.height));
  if (rw < 2 || rh < 2) return null;

  let roiSum = 0, allSum = 0, roiN = 0, allN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.abs(da[y * w + x] - db[y * w + x]);
      allSum += d; allN++;
      if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) { roiSum += d; roiN++; }
    }
  }
  const allMean = allSum / Math.max(1, allN);
  const roiMean = roiSum / Math.max(1, roiN);
  return roiMean / (allMean + 1e-4);   // 已用全脸均值归一;全脸几乎不动时该值大
}

/**
 * 姿态轨迹平滑性:按时间序找相邻样本的最大跳变。
 * 真人摇头/点头轨迹连续;3D 面具/照片活化/画面切换会出现跳变。
 * @returns {{samples:number, maxYaw:number, maxPitch:number, maxRoll:number, suspicious:boolean}}
 */
export function assessPoseJump(samples, { maxJumpNorm = 0.18, maxJumpDeg = 12 } = {}) {
  const out = { samples: samples.length, maxYaw: 0, maxPitch: 0, maxRoll: 0, suspicious: false };
  if (samples.length < 2) return out;
  let maxY = 0, maxP = 0, maxR = 0;
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1], c = samples[i];
    const dt = (c.t - p.t);
    if (dt <= 0 || dt > 400) continue;              // 间隔过大不比较
    maxY = Math.max(maxY, Math.abs(c.yaw - p.yaw));
    maxP = Math.max(maxP, Math.abs(c.pitch - p.pitch));
    maxR = Math.max(maxR, Math.abs((c.roll || 0) - (p.roll || 0)));
  }
  out.maxYaw = maxY; out.maxPitch = maxP; out.maxRoll = maxR;
  out.suspicious = maxY > maxJumpNorm || maxP > maxJumpNorm || maxR > maxJumpDeg;
  return out;
}
