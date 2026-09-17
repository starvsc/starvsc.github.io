/**
 * 人脸关键点 + 人像精细分割 演示页(portrait.js)
 *   - 人脸关键点:face-engine(68点,实时/静态图均可)
 *   - 人像分割:MediaPipe SelfieSegmentation(抠像/背景替换/蒙版高亮)
 */
import { ensureEngine, detectMetrics, drawOverlay } from './face-engine.js';
import { getSegmenter } from './portrait-seg.js';

const $ = (id) => document.getElementById(id);
const els = {
  video: $('pt-video'), seg: $('pt-seg'), ov: $('pt-ov'),
  start: $('pt-start'), stop: $('pt-stop'), upload: $('pt-upload'), file: $('pt-file'),
  mode: $('pt-mode'), bgcolor: $('pt-bgcolor'), key: $('pt-key'),
  dot: $('pt-dot'), state: $('pt-state'), msg: $('pt-msg'),
};

const S = {
  stream: null,
  seg: null,
  running: false,
  raf: 0,
  faceBusy: false,
  segBusy: false,
  lastSegAt: 0,
  mode: 'cutout',
  mask: null,        // 最近一帧分割蒙版
  tmp: null,
  tmpCtx: null,
};

function setState(text, ok) {
  els.state.textContent = text;
  els.dot.className = 'dotp' + (ok ? ' on' : '');
}
function setMsg(t) { els.msg.textContent = t; }

/* ---------- 画布尺寸 ---------- */
function syncSizes() {
  const w = els.video.videoWidth || 640;
  const h = els.video.videoHeight || 480;
  els.seg.width = w; els.seg.height = h;
  els.ov.width = w; els.ov.height = h;
  if (!S.tmp) {
    S.tmp = document.createElement('canvas');
    S.tmpCtx = S.tmp.getContext('2d');
  }
  S.tmp.width = w; S.tmp.height = h;
}

/* ---------- 摄像头 ---------- */
async function startCam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMsg('当前环境不支持摄像头,请用 localhost/https 打开。'); return;
  }
  setState('加载模型中…', false);
  setMsg('正在加载人脸关键点与人像分割模型(首次需联网,约 1~2MB)…');
  try {
    await ensureEngine((st) => {
      if (st === 'loading-models') setState('加载人脸模型…', false);
      if (st === 'ready') setState('模型就绪,请求摄像头', true);
    });
    if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    S.stream = stream;
    els.video.srcObject = stream;
    els.video.removeAttribute('src');
    await waitVideo(els.video, 8000);
    await startPipeline();
    setMsg('实时检测中:68 点人脸关键点 + 人像分割。切换右上模式/上传图片。');
  } catch (e) {
    setState('摄像头启动失败', false);
    setMsg('摄像头错误:' + ((e && e.message) || e));
  }
}

async function startPipeline() {
  syncSizes();
  S.seg = await getSegmenter({ onResult });
  els.stop.disabled = false;
  els.start.disabled = true;
  S.running = true;
  S.lastSegAt = 0;
  loop();
}

function loop() {
  if (!S.running || els.video.readyState < 2) return;
  const now = performance.now();
  // 人脸关键点
  if (!S.faceBusy) {
    S.faceBusy = true;
    detectMetrics(els.video)
      .then((m) => {
        if (!S.running) return;
        const kctx = els.ov.getContext('2d');
        if (els.key.checked) drawOverlay(kctx, m, els.ov.width, els.ov.height);
        else kctx.clearRect(0, 0, els.ov.width, els.ov.height);
        if (m && m.ok) setState('检测中:人脸 ✓ · 分割运行中', true);
        else if (m && (m.reason === 'no-face' || m.reason === 'too-small')) setState('未检测到人脸', false);
      })
      .catch(() => {})
      .finally(() => { S.faceBusy = false; });
  }
  // 人像分割(节流 ~130ms)
  if (S.seg && !S.segBusy && now - S.lastSegAt > 130) {
    S.segBusy = true;
    S.lastSegAt = now;
    S.seg.send({ image: els.video }).catch(() => {}).finally(() => { S.segBusy = false; });
  }
  S.raf = requestAnimationFrame(loop);
}

/* ---------- 分割结果 ---------- */
function onResult(results) {
  if (!results || !results.segmentationMask) return;
  S.mask = results.segmentationMask;
  renderSeg();
}

function renderSeg() {
  const ctx = els.seg.getContext('2d');
  const W = els.seg.width, H = els.seg.height;
  ctx.clearRect(0, 0, W, H);
  const mode = S.mode || 'cutout';
  if (mode === 'off') return;
  try {
    if (mode === 'cutout') {
      ctx.drawImage(makeCutout(), 0, 0, W, H);
    } else if (mode === 'bg') {
      ctx.fillStyle = els.bgcolor.value || '#2f6fd6';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(makeCutout(), 0, 0, W, H);
    } else { // overlay 高亮
      ctx.drawImage(els.video, 0, 0, W, H);
      ctx.globalAlpha = 0.55;
      ctx.drawImage(makeTint(), 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  } catch (e) { /* 忽略绘制异常 */ }
}

/** 把人像从当前帧抠出(透明背景) */
function makeCutout() {
  const c = S.tmpCtx, W = S.tmp.width, H = S.tmp.height;
  c.save();
  c.clearRect(0, 0, W, H);
  c.drawImage(els.video, 0, 0, W, H);
  c.globalCompositeOperation = 'destination-in';
  if (S.mask) c.drawImage(S.mask, 0, 0, W, H);
  c.restore();
  return S.tmp;
}

/** 生成"金色蒙版"叠加层(用于 overlay 高亮) */
function makeTint() {
  const c = S.tmpCtx, W = S.tmp.width, H = S.tmp.height;
  c.save();
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#ffd75e';
  c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'destination-in';
  if (S.mask) c.drawImage(S.mask, 0, 0, W, H);
  c.restore();
  return S.tmp;
}

/* ---------- 静态图片上传 ---------- */
async function useUploaded(file) {
  stopNow();
  els.video.srcObject = null;
  const url = URL.createObjectURL(file);
  els.video.src = url;
  els.video.loop = false;
  try {
    await new Promise((res, rej) => {
      els.video.onloadeddata = () => res();
      els.video.onerror = () => rej(new Error('图片加载失败'));
    });
    els.video.pause();
    syncSizes();
    setMsg('静态图模式:正在检测关键点与人像分割…');
    S.seg = await getSegmenter({ onResult });
    const m = await detectMetrics(els.video);
    if (els.key.checked) drawOverlay(els.ov.getContext('2d'), m, els.ov.width, els.ov.height);
    await S.seg.send({ image: els.video }).catch(() => {});
    els.stop.disabled = false;
    els.start.disabled = true;
    setState(m && m.ok ? '静态图:人脸 ✓' : '静态图:未检测到人脸', !!(m && m.ok));
    setMsg('静态检测完成。可换图,或点"开启摄像头"回到实时。');
  } catch (e) {
    setMsg('图片处理失败:' + ((e && e.message) || e));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- 停止 ---------- */
function stopNow() {
  S.running = false;
  if (S.raf) cancelAnimationFrame(S.raf);
  if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
  els.video.srcObject = null;
  els.video.removeAttribute('src');
  const segC = els.seg.getContext('2d');
  const ovC = els.ov.getContext('2d');
  segC.clearRect(0, 0, els.seg.width, els.seg.height);
  ovC.clearRect(0, 0, els.ov.width, els.ov.height);
  els.start.disabled = false;
  els.stop.disabled = true;
  setState('已停止', false);
}

/* ---------- 工具 & 事件 ---------- */
function waitVideo(video, timeout) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && video.videoWidth) return resolve();
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('video timeout')); } }, timeout);
    const on = () => {
      if (video.readyState >= 2 && video.videoWidth) {
        if (done) return;
        done = true; clearTimeout(t);
        video.removeEventListener('loadeddata', on);
        video.removeEventListener('playing', on);
        resolve();
      }
    };
    video.addEventListener('loadeddata', on);
    video.addEventListener('playing', on);
    on();
  });
}

S.mode = els.mode.value;
els.start.addEventListener('click', startCam);
els.stop.addEventListener('click', stopNow);
els.upload.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  if (els.file.files && els.file.files[0]) useUploaded(els.file.files[0]);
  els.file.value = '';
});
els.mode.addEventListener('change', () => { S.mode = els.mode.value; });
