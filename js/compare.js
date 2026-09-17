/**
 * 双图人脸比对(compare.js)
 *
 * 上传两张人脸图片 -> 网关 /api/v1/face/compare ->
 * 队友 faceauth_compare2(512d 特征 + 余弦) -> 是否同一人。
 *
 * 说明:此功能必须连后端(真实算法),mock 模式不伪造“是否同人”结论。
 */
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const els = {
  mode: $('cmp-mode'),
  slotA: $('slotA'), slotB: $('slotB'),
  fileA: $('fileA'), fileB: $('fileB'),
  err: $('cmp-err'),
  btn: $('btn-compare'),
  res: $('res-box'),
  verdict: $('res-verdict'),
  note: $('res-note'),
  score: $('res-score'), thr: $('res-thr'), ms: $('res-ms'), total: $('res-total'),
};

const state = { a: null, b: null, busy: false };

/* ---------- 图片处理 ---------- */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/** 大图先等比缩到 maxSide 内再编码,控制上传体积(人脸识别 640~800 足够) */
async function fileToDataUrl(file, maxSide = 800, quality = 0.9) {
  if (!/^image\/(png|jpe?g|webp|bmp)$/.test(file.type)) {
    throw new Error('仅支持图片文件(png/jpg/webp/bmp)');
  }
  if (file.size > 12 * 1024 * 1024) throw new Error('图片超过 12MB,请换小一点的图');
  const dataUrl = await readAsDataURL(file);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('图片解码失败')); img.src = dataUrl; });
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}

/* ---------- UI ---------- */
function setErr(msg) { els.err.textContent = msg || ''; }

function fillSlot(slotEl, dataUrl) {
  slotEl.classList.add('filled');
  const prev = slotEl.querySelector('img');
  if (prev) prev.remove();
  const img = document.createElement('img');
  img.src = dataUrl;
  slotEl.insertBefore(img, slotEl.querySelector('.remove'));
}

function clearSlot(key) {
  const slot = key === 'a' ? els.slotA : els.slotB;
  state[key] = null;
  slot.classList.remove('filled');
  const img = slot.querySelector('img');
  if (img) img.remove();
  slot.querySelector('.ph').style.display = '';
  setErr('');
  refreshBtn();
}

function refreshBtn() {
  els.btn.disabled = !(state.a && state.b);
}

async function pick(key) {
  const file = key === 'a' ? els.fileA : els.fileB;
  if (!file.files || !file.files[0]) return;
  setErr('');
  try {
    const dataUrl = await fileToDataUrl(file.files[0]);
    state[key] = dataUrl;
    const slot = key === 'a' ? els.slotA : els.slotB;
    fillSlot(slot, dataUrl);
    refreshBtn();
  } catch (e) {
    setErr(e.message || '图片处理失败');
  } finally {
    file.value = '';
  }
}

/* ---------- 比对 ---------- */
async function doCompare() {
  if (state.busy) return;
  setErr('');
  if (!state.a || !state.b) { setErr('请先上传两张图片'); return; }
  if (!api.isHttp()) {
    setErr('当前未连接后端:双图比对需要启动网关(真实 C++ 比对),请先运行 server/run.sh');
    return;
  }
  state.busy = true;
  els.btn.disabled = true;
  els.btn.querySelector('.btn-label').textContent = '比对中…';
  els.btn.querySelector('.spinner').hidden = false;
  const tWall = performance.now();
  try {
    const res = await api.compare({ imageA: state.a, imageB: state.b });
    if (!res.ok) { setErr(res.message || '比对失败'); els.res.classList.remove('show'); return; }
    renderResult(res.data, performance.now() - tWall);
  } finally {
    state.busy = false;
    els.btn.querySelector('.btn-label').textContent = '开始比对';
    els.btn.querySelector('.spinner').hidden = true;
    refreshBtn();
  }
}

function renderResult(d, wallMs) {
  const same = !!d.same;
  els.verdict.textContent = same ? '✓ 是同一人' : '✕ 不是同一人';
  els.verdict.className = 'verdict ' + (same ? 'yes' : 'no');
  els.score.textContent = d.score != null ? d.score.toFixed(4) : '-';
  els.thr.textContent = d.threshold != null ? d.threshold.toFixed(4) : '-';
  // 比对耗时只计后端人脸比对部分(worker 的 elapsedMs),便于和算法指标同口径
  els.ms.textContent = d.elapsedMs != null ? (d.elapsedMs / 1000).toFixed(2) + ' s' : '-';
  els.total.textContent = wallMs != null ? (wallMs / 1000).toFixed(2) + ' s' : '-';
  // 接近阈值时加提示
  els.note.style.display = 'none';
  if (d.score != null && d.threshold != null && Math.abs(d.score - d.threshold) < 0.05) {
    els.note.textContent = '分数接近阈值,建议换更清晰的正脸图复核';
    els.note.style.display = 'inline-block';
  }
  els.res.classList.add('show');
}

/* ---------- 初始化 ---------- */
function bind() {
  els.slotA.addEventListener('click', () => els.fileA.click());
  els.slotB.addEventListener('click', () => els.fileB.click());
  els.fileA.addEventListener('change', () => pick('a'));
  els.fileB.addEventListener('change', () => pick('b'));
  document.querySelectorAll('[data-clear]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearSlot(b.dataset.clear === 'slotA' ? 'a' : 'b');
    });
  });
  els.btn.addEventListener('click', doCompare);
}

async function init() {
  await api.initMode();
  if (api.isHttp()) {
    els.mode.classList.add('on');
    els.mode.querySelector('span').textContent = '已连接后端 · 真实 C++ 比对';
  } else {
    els.mode.querySelector('span').textContent = '未连接后端 · 双图比对需启动网关';
    els.btn.disabled = true;
  }
  bind();
}

init();
