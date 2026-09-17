/**
 * 活体自检台(debug.js)
 *
 * 不依赖登录流程,直接打开摄像头:
 *   - 复用 js/face-engine.js:加载模型 → 实时检测 → 68 点 + 面框叠加
 *   - 实时显示 左/右/平均 EAR、MAR、yaw、pitch、FPS、检测耗时、置信度
 *   - EAR / MAR 滚动波形(便于观察眨眼下探、张嘴上升)
 *   - 按 config.js LIVENESS 参数实时计算“自适应闭眼参考线”,并统计眨眼命中次数,
 *     帮助在真机上标定阈值。
 */
import { CFG } from './config.js';
import { ensureEngine, detectMetrics, drawOverlay } from './face-engine.js';

const $ = (id) => document.getElementById(id);

/* 阈值参数(来自 config) */
const L = CFG.LIVENESS;

const els = {
  video: $('dbg-video'),
  overlay: $('dbg-overlay'),
  dot: $('dbg-dot'),
  chipText: $('dbg-chip-text'),
  hint: $('dbg-hint'),
  btnStart: $('dbg-btn-start'),
  btnStop: $('dbg-btn-stop'),
  btnLabel: $('dbg-btn-label'),
  modelState: $('dbg-model-state'),
  // 数值
  fps: $('dbg-fps'), ms: $('dbg-ms'), ratio: $('dbg-ratio'), score: $('dbg-score'),
  earL: $('dbg-earL'), earR: $('dbg-earR'), ear: $('dbg-ear'),
  mar: $('dbg-mar'), yaw: $('dbg-yaw'), pitch: $('dbg-pitch'),
  base: $('dbg-base'), closedRef: $('dbg-closedref'), openRef: $('dbg-openref'), rule: $('dbg-rule'),
  blinkCount: $('dbg-blinkcount'), guide: $('dbg-guide'),
  disp: $('dbg-disp'), scale: $('dbg-scale'), roll: $('dbg-roll'),
  gateState: $('dbg-gate-state'), gateThr: $('dbg-gate-thr'),
  earChart: $('dbg-ear-chart'), marChart: $('dbg-mar-chart'),
};

const S = {
  stream: null,
  ctx: null,
  raf: 0,
  detectBusy: false,
  running: false,
  fps: 0,
  lastFrameT: 0,
  earHist: [],       // {t,ear} 用于基线(1.5s)
  earBuf: [],        // {t,v} 用于波形(8s)
  marBuf: [],
  blink: { phase: 'open', at: 0, count: 0 },
  faceLast: null,    // 晃动门控:{cx,cy,bw,t}
  disp: 0, scale: 0, roll: 0, moving: false,
};

/* ---------------- 波形/图表 ---------------- */
function pushBuf(buf, t, v, keepMs) {
  buf.push({ t, v });
  const cut = t - keepMs;
  while (buf.length && buf[0].t < cut) buf.shift();
}

function drawChart(canvas, buf, opts) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fbfcfe';
  ctx.fillRect(0, 0, w, h);
  if (!buf.length) return;

  const { yMax, color, refs = [] } = opts;
  const t0 = buf[buf.length - 1].t;
  const span = 8000;
  const xOf = (t) => ((t - (t0 - span)) / span) * w;
  const yOf = (v) => h - 3 - Math.min(1, Math.max(0, v / yMax)) * (h - 8);

  // 参考线
  refs.forEach((r) => {
    ctx.strokeStyle = r.color;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const y = yOf(r.value);
    ctx.moveTo(0, y); ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = r.color;
    ctx.font = '10px ui-monospace,Consolas,monospace';
    ctx.fillText(r.label, 4, y - 3);
  });

  // 波形
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  buf.forEach((p, i) => {
    const x = xOf(p.t), y = yOf(p.v);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/* ---------------- 指标/判定 ---------------- */
function p80(vals) {
  if (!vals.length) return null;
  const s = vals.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.8))];
}

function thresholds(now) {
  const win = now - (L.eyeHistoryMs || 800);
  const vals = S.earHist.filter((e) => e.t >= win).map((e) => e.ear);
  const raw = p80(vals);
  const base = raw == null
    ? L.eyeBaseCap
    : Math.min(L.eyeBaseCap, Math.max(L.eyeBaseFloor, raw));
  const closedThr = Math.max(L.eyeClosedFloor, Math.min(base * L.eyeClosedFactor, base - L.eyeClosedOffset));
  const openThr = Math.max(L.eyeClosedFloor + 0.02, base * L.eyeOpenRecover);
  return { base, closedThr, openThr };
}

/* 计算相邻帧人脸整体晃动/倾斜(与 liveness 的 motionGate 同一套规则) */
function computeMotion(m, now) {
  S.roll = m.roll || 0;
  const G = (L.motionGate && L.motionGate.enabled) ? L.motionGate : null;
  if (!G) { S.disp = 0; S.scale = 0; S.moving = false; return; }
  const bw = m.box.width || 1;
  const cx = m.box.x + bw / 2;
  const cy = m.box.y + m.box.height / 2;
  const last = S.faceLast;
  S.faceLast = { cx, cy, bw, t: now };

  let dispOver = false, scaleOver = false;
  if (last && now - last.t <= G.maxDtMs) {
    const disp = Math.hypot(cx - last.cx, cy - last.cy) / bw;
    const scale = Math.abs(bw - last.bw) / bw;
    S.disp = disp;
    S.scale = scale;
    dispOver = disp > (G.moveRatio || 0.08);
    scaleOver = scale > (G.scaleRatio || 0.15);
  } else {
    S.disp = 0;
    S.scale = 0;
  }
  const tiltOver = !!(G.rollAbsDeg) && Math.abs(S.roll) > G.rollAbsDeg;
  S.moving = dispOver || scaleOver || tiltOver;
}

function updateGateUI() {
  const G = L.motionGate || {};
  const parts = [];
  if (G.moveRatio) parts.push(`位移>${G.moveRatio.toFixed(2)}`);
  if (G.scaleRatio) parts.push(`尺度>${G.scaleRatio.toFixed(2)}`);
  if (G.rollAbsDeg) parts.push(`|roll|>${G.rollAbsDeg}°`);
  els.gateThr.textContent = parts.length ? '门限:' + parts.join(' 或 ') : '';
  els.disp.textContent = S.disp ? S.disp.toFixed(3) : '-';
  els.scale.textContent = S.scale ? S.scale.toFixed(3) : '-';
  els.roll.textContent = S.roll ? Math.abs(S.roll).toFixed(1) + '°' : '-';
  if (S.moving) {
    els.gateState.textContent = '晃动/倾斜 · 眨眼/张嘴判定暂停';
    els.gateState.classList.add('warn');
    els.disp.classList.add('warn');
    els.scale.classList.add('warn');
    els.roll.classList.add('warn');
  } else {
    els.gateState.textContent = '头部端正 · 判定正常';
    els.gateState.classList.remove('warn');
    els.disp.classList.remove('warn');
    els.scale.classList.remove('warn');
    els.roll.classList.remove('warn');
  }
}

function observeBlink(m, now, moving) {
  if (moving) { S.blink.phase = 'open'; return thresholds(now); } // 晃动暂停
  const { base, closedThr, openThr } = thresholds(now);
  if (S.blink.phase === 'open') {
    if (m.ear < closedThr) { S.blink.phase = 'closed'; S.blink.at = now; }
  } else {
    const dur = now - S.blink.at;
    if (m.ear > openThr) {
      S.blink.phase = 'open';
      if (dur >= L.blinkMinClosedMs && dur <= L.blinkMaxClosedMs) S.blink.count += 1;
    } else if (dur > L.blinkMaxClosedMs) {
      S.blink.phase = 'open';
    }
  }
  return thresholds(now);
}

/* ---------------- 检测循环 ---------------- */
function setChip(text, kind) {
  els.chipText.textContent = text;
  els.dot.className = 'dotc' + (kind === 'good' ? ' good' : kind === 'warn' ? ' warn' : '');
}

async function detectOnce() {
  const t0 = performance.now();
  const m = await detectMetrics(els.video);
  const ms = performance.now() - t0;
  const now = performance.now();

  // 波形数据
  if (m && m.ok) {
    pushBuf(S.earBuf, now, m.ear, 8000);
    pushBuf(S.marBuf, now, m.mar, 8000);
    S.earHist.push({ t: now, ear: m.ear });
    const cut = now - (L.eyeHistoryMs || 800) - 500;
    while (S.earHist.length && S.earHist[0].t < cut) S.earHist.shift();

    computeMotion(m, now);
    updateGateUI();
    const th = observeBlink(m, now, S.moving);

    const thold = thresholds(now);
    els.earL.textContent = m.leftEAR.toFixed(2);
    els.earR.textContent = m.rightEAR.toFixed(2);
    els.ear.textContent = m.ear.toFixed(2);
    els.mar.textContent = m.mar.toFixed(2);
    els.yaw.textContent = m.yaw.toFixed(2);
    els.pitch.textContent = m.pitch.toFixed(2);
    els.ratio.textContent = m.widthRatio.toFixed(2);
    els.score.textContent = m.score.toFixed(2);
    els.ms.textContent = ms.toFixed(0) + ' ms';

    // 参考线 & 判定说明
    els.base.textContent = th.base.toFixed(3);
    els.closedRef.textContent = th.closedThr.toFixed(3);
    els.openRef.textContent = th.openThr.toFixed(3);
    els.rule.textContent =
      `EAR < ${th.closedThr.toFixed(3)} 记为闭眼 · 恢复到 > ${th.openThr.toFixed(3)} 记为一次眨眼 · 闭眼时长 ${L.blinkMinClosedMs}~${L.blinkMaxClosedMs}ms`;
    els.blinkCount.textContent = String(S.blink.count);

    setChip('检测到人脸 · 68 点', 'good');
    const hints = [
      `<span>EAR ${m.ear.toFixed(2)}</span>`,
      `<span>MAR ${m.mar.toFixed(2)}</span>`,
      `<span>yaw ${m.yaw.toFixed(2)}</span>`,
      `<span>pitch ${m.pitch.toFixed(2)}</span>`,
      `<span>${S.blink.count} 次眨眼</span>`,
    ];
    els.hint.innerHTML = hints.join('');

    if (m.ear < thold.closedThr) {
      els.ear.classList.add('warn'); els.ear.classList.remove('ok');
      setChip('闭眼中…', 'warn');
    } else {
      els.ear.classList.remove('warn'); els.ear.classList.add('ok');
    }
  } else {
    const reason = m ? m.reason : '?';
    setChip(reason === 'no-face' ? '未检测到人脸' : reason === 'too-small' ? '人脸太远/太小' : reason === 'no-engine' ? '引擎未就绪' : '无结果', 'warn');
    els.earL.textContent = els.earR.textContent = els.ear.textContent = '-';
    els.mar.textContent = els.yaw.textContent = els.pitch.textContent = '-';
    S.moving = false; S.disp = 0; S.scale = 0; S.roll = 0;
    updateGateUI();
  }

  drawOverlay(S.ctx, m, els.overlay.width, els.overlay.height);
  drawChart(els.earChart, S.earBuf, {
    yMax: 0.5, color: '#39d6ff',
    refs: [{ value: thresholds(now).closedThr, color: '#c9a227', label: 'closed' }],
  });
  drawChart(els.marChart, S.marBuf, { yMax: 0.8, color: '#ff9ad5' });
  S.detectBusy = false;
}

function frame(ts) {
  if (!S.running) return;
  if (S.lastFrameT) {
    const dt = ts - S.lastFrameT;
    S.fps = S.fps ? S.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
    els.fps.textContent = S.fps.toFixed(1) + ' fps';
  }
  S.lastFrameT = ts;
  if (!S.detectBusy && els.video.readyState >= 2) {
    S.detectBusy = true;
    detectOnce().catch(() => { S.detectBusy = false; });
  }
  S.raf = requestAnimationFrame(frame);
}

/* ---------------- 启停 ---------------- */
function stop() {
  S.running = false;
  if (S.raf) cancelAnimationFrame(S.raf);
  if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
  els.video.srcObject = null;
  if (S.ctx) S.ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  els.btnLabel.textContent = '开启摄像头自检';
  setChip('已停止', '');
  els.hint.innerHTML = '';
}

async function start() {
  els.btnStart.disabled = true;
  els.btnStop.disabled = false;
  els.btnLabel.textContent = '加载模型中…';
  setChip('加载人脸模型…', '');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    els.modelState.textContent = '当前环境不支持摄像头,请使用 localhost 或 https 打开本页。';
    stop(); return;
  }

  const engPromise = ensureEngine((st) => {
    if (st === 'loading-models') { setChip('加载模型…', ''); els.modelState.textContent = '正在加载 人脸检测 + 68点 模型(首次约 1~2MB)…'; }
    if (st === 'ready') { setChip('模型就绪', 'good'); els.modelState.textContent = '模型已就绪。正在请求摄像头…'; }
    if (st === 'error') { els.modelState.textContent = '模型加载失败:请检查网络,或先运行 python tools/fetch_assets.py 下载到本地。'; }
  }).catch((e) => e);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: CFG.CAMERA.width }, height: { ideal: CFG.CAMERA.height }, facingMode: CFG.CAMERA.facingMode },
      audio: false,
    });
    const eng = await engPromise;
    if (eng instanceof Error) { els.modelState.textContent = '模型加载失败:请检查网络或先运行 tools/fetch_assets.py。'; stream.getTracks().forEach(t=>t.stop()); stop(); return; }

    S.stream = stream;
    els.video.srcObject = stream;
    await waitVideo(els.video, 8000);

    els.overlay.width = els.video.videoWidth || CFG.CAMERA.width;
    els.overlay.height = els.video.videoHeight || CFG.CAMERA.height;
    S.ctx = els.overlay.getContext('2d');

    S.earHist = []; S.earBuf = []; S.marBuf = []; S.blink = { phase: 'open', at: 0, count: 0 };
    S.faceLast = null; S.disp = 0; S.scale = 0; S.roll = 0; S.moving = false;
    updateGateUI();
    S.fps = 0; S.lastFrameT = 0;
    els.blinkCount.textContent = '0';
    els.btnLabel.textContent = '自检中…(完成后点“停止”)';
    S.running = true;
    els.modelState.textContent = '正在实时检测。请按提示做动作观察数值。';
    S.raf = requestAnimationFrame(frame);
  } catch (err) {
    els.modelState.textContent = '摄像头启动失败:' + ((err && err.message) || '未知错误');
    stop();
  }
}

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

els.btnStart.addEventListener('click', start);
els.btnStop.addEventListener('click', stop);
els.guide.textContent = '测试方法:正对镜头分别试 ① 睁眼→闭眼→睁眼(看 EAR 波形下探与“眨眼计数”);② 张大嘴(看 MAR 波形上升);③ 左右摇头(看 yaw 变化)。④ 晃动头部或歪头,看“晃动门控”是否变红暂停(位移/尺度/|roll| 任一超限都会暂停眨眼/张嘴判定)。';
updateGateUI();
