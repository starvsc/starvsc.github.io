/**
 * 摄像头采集向导(camera.js)
 *
 * 流程(与人脸关键点检测 + 动作活体结合):
 *   0. 打开摄像头 + 并行加载 人脸检测/68点关键点 模型(face-engine)
 *   1. 实时检测:画面叠加 68 点 + 面框 + EAR/MAR/yaw 指标(与预览镜像对齐)
 *   2. 动作活体挑战:按随机指令完成 眨眼/张嘴/摇头/点头
 *      ——静态照片/打印图无法完成动作;视频重放难以匹配随机指令序列
 *   3. 姿态采样:注册 3 姿态(正/左/右)、登录 1 张正面,返回 JPEG dataURL
 *
 * 对外:
 *   openCameraWizard({ mode:'enroll'|'verify' })
 *   -> { ok:true, samples:[dataUrl], liveness:{...} }
 *   -> { ok:false, reason:'cancelled'|'unsupported'|'denied'|'error'|'liveness'|'engine' }
 */
import { CFG } from './config.js';
import { ensureEngine, detectMetrics, drawOverlay } from './face-engine.js';
import { createLiveness } from './liveness.js';
import * as sec from './spoof-engine.js';

const SEC_CFG = CFG.SECURITY;

const $ = (id) => document.getElementById(id);
let opening = false;

export function openCameraWizard({ mode = 'enroll' } = {}) {
  if (opening) return Promise.resolve({ ok: false, reason: 'busy' });
  opening = true;
  return new Promise((resolve) => {
    const session = createSession({ mode, resolve });
    session.open().catch(() => session.close({ ok: false, reason: 'error' }));
  });
}

function createSession({ mode, resolve }) {
  const poses = CFG.POSES[mode] || [];
  const state = {
    stream: null,
    engine: null,
    closed: false,
    phase: 'init',            // init | challenge | sample | done
    stepIndex: 0,
    samples: [],              // { poseKey,label,dataUrl }
    verifyFrames: [],         // verify 多帧: {image,face,landmarks,ts}
    captureT0: 0,             // 本次采集的起点(performance.now),用于帧的真实时间戳
    bursting: false,
    lastMetrics: null,
    detectBusy: false,
    rafId: 0,
    overlayCtx: null,
    challenge: null,
    goingSample: false,
    autoArmedAt: 0,
    timers: [],
    onKey: null,
    lastInstruction: '',
    // 安全增强软信号(需求4-7)
    sec: { hints: [], poseSamples: [], ring: [], reflect: null, reflectDone: false, probeBusy: false, prevDone: -1 },
    onResize: null,           // 铺满窗口时重算预览尺寸
  };

  const els = {
    modal: $('cam-modal'),
    title: $('cam-title'),
    stage: $('cam-stage'),
    video: $('cam-video'),
    overlay: $('cam-overlay'),
    command: $('cam-command'),
    stateText: $('cam-state-text'),
    lvDot: $('lv-dot'),
    poseBar: $('pose-bar'),
    tip: $('cam-tip'),
    action: $('cam-action'),
    actionLabel: $('cam-action-label'),
    cancel: $('cam-cancel'),
    close: $('cam-close'),
  };

  /* ============ 生命周期 ============ */
  function settle(result) {
    if (state.closed) return;
    state.closed = true;
    if (!result.spoof) {
      try { result.spoof = secSummary(); } catch (e) { /* ignore */ }
    }
    cleanup();
    resolve(result);
    opening = false;
  }

  function later(fn, ms) {
    const t = setTimeout(fn, ms);
    state.timers.push(t);
    return t;
  }

  function cleanup() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.timers.forEach(clearTimeout);
    state.timers = [];
    if (state.onKey) document.removeEventListener('keydown', state.onKey);
    if (state.onResize) { window.removeEventListener('resize', state.onResize); state.onResize = null; }
    stopStream();
    els.modal.setAttribute('hidden', '');
    document.body.style.overflow = '';
    els.action.disabled = true;
    clearOverlay();
    els.command.textContent = '';
    try { clearFlash(); } catch (e) { /* ignore */ }
    try { hideGuide(); } catch (e) { /* ignore */ }
    // 还原铺满窗口布局
    try {
      els.modal.classList.remove('cam-fs');
      els.stage.style.width = '';
      els.stage.style.height = '';
    } catch (e) { /* ignore */ }
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    els.video.srcObject = null;
  }

  function clearOverlay() {
    if (els.overlay && state.overlayCtx) {
      state.overlayCtx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    }
  }

  /* ============ UI 工具 ============ */
  function setStateText(text, kind) {
    els.stateText.textContent = text;
    els.lvDot.className = 'lv-dot' + (kind === 'warn' ? ' warn' : '') + (kind === 'good' ? ' good' : '');
  }

  function setTip(html) {
    els.tip.textContent = html;
  }

  function setCommand(text, tone) {
    if (els.command) {
      els.command.textContent = text || '';
      els.command.className = 'cam-command' + (tone ? ' ' + tone : '');
    }
  }

  /** 通用:把 chips(每项 {label,state:active|done|todo})渲染到步骤条 */
  function renderChips(chips) {
    els.poseBar.innerHTML = '';
    chips.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'pose-chip' + (c.state === 'active' ? ' active' : '') + (c.state === 'done' ? ' done' : '');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = c.no ? c.no : '';
      el.appendChild(n);
      const t = document.createElement('span');
      t.textContent = c.label;
      el.appendChild(t);
      els.poseBar.appendChild(el);
    });
  }

  function challengeChips(snap) {
    return snap.records.map((r) => ({ label: r.label, state: 'done' }))
      .concat(snap.current ? [{ label: snap.current.label, state: 'active' }] : [])
      .concat(
        Array.from({ length: Math.max(0, snap.total - snap.records.length - (snap.current ? 1 : 0)) }, () => ({ label: '…', state: 'todo' }))
      );
  }

  function poseChips() {
    return poses.map((p, i) => ({
      label: p.label,
      state: i < state.stepIndex ? 'done' : i === state.stepIndex ? 'active' : 'todo',
      no: String(i + 1),
    }));
  }

  function setPhase(phase) {
    state.phase = phase;
    // 阶段在 cam-state 里提示文字由各处 setStateText 控制
  }

  /* ---------- 铺满浏览器窗口 ---------- */
  /** 给弹窗加 cam-fs 类,使摄像头界面铺满窗口(预览仍保持 4:3 居中最大化) */
  function applyWindowMode() {
    if (!CFG.CAMERA.WINDOW_FULLSCREEN || !els.modal) return;
    els.modal.classList.add('cam-fs');
    refitSoon();
  }

  /** 步骤条/质量条高度变化后多次重算(布局稳定需要一两帧) */
  function refitSoon() {
    if (!CFG.CAMERA.WINDOW_FULLSCREEN) return;
    [30, 180, 480].forEach((ms) => later(fitStage, ms));
  }

  /** 在可用空间内把 4:3 预览放到最大:避免 cover 裁切导致 68 点叠加与画面错位 */
  function fitStage() {
    if (!els.modal || !els.modal.classList.contains('cam-fs')) return;
    const card = els.modal.querySelector('.cam-card');
    if (!card) return;
    let used = 0;
    for (const el of card.children) {
      if (el === els.stage) continue;
      used += el.getBoundingClientRect().height || 0;
    }
    const availH = Math.max(200, window.innerHeight - used - 8);
    const availW = window.innerWidth || 1;
    // 预览框必须跟随摄像头「实际」宽高比:视频用 object-fit:cover 填满预览框,
    // 而叠加层画布是按视频像素尺寸再拉伸到预览框的 —— 两者比例不一致时
    // 68 点就会和画面错位。此前写死 4:3,只在摄像头恰好是 640x480 时才正确,
    // 一旦请求更高的 16:9 模式就会错位。
    const vw = els.video.videoWidth || 0;
    const vh = els.video.videoHeight || 0;
    const ar = vw > 0 && vh > 0 ? vw / vh : 4 / 3;
    const w = Math.min(availW, availH * ar);
    const h = w / ar;
    els.stage.style.width = Math.round(w) + 'px';
    els.stage.style.height = Math.round(h) + 'px';
  }

  /* ============ 打开向导 ============ */
  async function open() {
    const { width, height, facingMode } = CFG.CAMERA;
    els.modal.removeAttribute('hidden');
    applyWindowMode();
    state.onResize = () => {
      if (_ellipse) return;                 // 色光测量中不改动布局,避免椭圆错位
      fitStage();
      if (_guideEl) showGuide();
    };
    window.addEventListener('resize', state.onResize);
    document.body.style.overflow = 'hidden';
    els.title.textContent = mode === 'enroll' ? '人脸录入 · 活体挑战' : '人脸认证 · 活体挑战';
    els.stage.classList.remove('cam-off');
    els.action.disabled = true;
    els.cancel.disabled = false;
    els.close.disabled = false;
    els.actionLabel.textContent = '拍摄';
    bindActions();
    setTip('正在初始化,请稍候…');
    setStateText('正在加载人脸模型…', '');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStageOff('当前环境不支持摄像头。请使用 localhost 或 https 打开页面。');
      return settle({ ok: false, reason: 'unsupported' });
    }

    // 并行:开摄像头 + 加载人脸引擎
    const enginePromise = ensureEngine((st) => {
      if (st === 'loading-models') setStateText('正在加载人脸模型(首次约 1~2MB)…', '');
      else if (st === 'error') setStateText('人脸模型加载失败,请检查网络', 'warn');
    }).catch((e) => e);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height }, facingMode },
        audio: false,
      });
      if (state.closed) { stream.getTracks().forEach((t) => t.stop()); return; }
      state.stream = stream;
      els.video.srcObject = stream;
      await waitForVideo(els.video, 8000);
      if (state.closed) return;

      const eng = await enginePromise;
      if (eng instanceof Error || !eng) {
        setStageOff('人脸关键点模型加载失败,请检查网络后重试');
        return settle({ ok: false, reason: 'engine' });
      }
      state.engine = eng;
      initOverlay();
      refitSoon();          // 视频尺寸已知,按真实宽高比重算预览框
      startLoop();
      beginChallenge();
    } catch (err) {
      handleCamError(err);
    }
  }

  function handleCamError(err) {
    let reason = 'error';
    const msgMap = [
      [/NotAllowed|Permission/, () => { reason = 'denied'; return '摄像头权限被拒绝,请在浏览器地址栏允许后重试'; }],
      [/NotFound/, () => '未检测到可用摄像头设备'],
      [/NotReadable|TrackStartError/, () => '摄像头被其他应用占用,请关闭后重试'],
    ];
    let text = '摄像头启动失败:' + ((err && err.message) || '未知错误');
    for (const [re, fn] of msgMap) {
      if (re.test(err && err.name || '')) { text = fn(); break; }
    }
    setStageOff(text);
    later(() => settle({ ok: false, reason }), 300);
  }

  /* ============ overlay 与检测循环 ============ */
  function initOverlay() {
    const vw = els.video.videoWidth || CFG.CAMERA.width;
    const vh = els.video.videoHeight || CFG.CAMERA.height;
    els.overlay.width = vw;
    els.overlay.height = vh;
    state.overlayCtx = els.overlay.getContext('2d');
  }

  function startLoop() {
    const loop = () => {
      if (state.closed) return;
      if (!state.detectBusy && els.video && els.video.readyState >= 2) {
        state.detectBusy = true;
        detectMetrics(els.video)
          .then((m) => onMetrics(m))
          .catch(() => {})
          .finally(() => { state.detectBusy = false; });
      }
      state.rafId = requestAnimationFrame(loop);
    };
    state.rafId = requestAnimationFrame(loop);
  }

  function onMetrics(m) {
    if (state.closed) return;
    state.lastMetrics = m;
    drawOverlay(state.overlayCtx, m, els.overlay.width, els.overlay.height);
    const now = performance.now();

    if (state.phase === 'challenge' && state.challenge) {
      if (m && m.ok) collectSecSamples(m, now);

      const snap = state.challenge.tick(m, now);
      if (snap.done > state.sec.prevDone && m && m.ok) {
        state.sec.prevDone = snap.done;
        const rec = snap.records[snap.records.length - 1];
        if (rec && rec.key === 'open_mouth') evalLocalDeform(rec.key);
      }
      updateChallengeUI(snap, m, now);
      if (snap.state === 'fail') {
        settle({ ok: false, reason: 'liveness', liveness: state.challenge.summary() });
      } else if (snap.state === 'pass') {
        if (!state.goingSample) {
          state.goingSample = true;
          setCommand('活体挑战通过 ✓', 'ok');
          later(() => nextAfterChallenge(), 500);   // 动作通过后再做 屏幕反射挑战
        }
      }
    } else if (state.phase === 'reflect') {
      // 屏幕反射挑战进行中:让人脸框挖洞跟随人脸
      if (m && m.ok) updateReflectHole(m);
    } else if (state.phase === 'sample') {
      updateSampleUI(m, now);
    } else if (state.phase === 'init') {
      // 等待
    }
  }

  /* ============ 安全增强软信号(需求4-7) ============ */

  /* ---------- 屏幕反射挑战(动作活体通过后执行) ---------- */
  let _flashEl = null;      // 全窗闪光层(挂在 #cam-modal 上,可覆盖整个浏览器窗口)
  let _guideEl = null;      // 中央椭圆准心
  let _guideText = '';      // 准心提示文案
  let _ellipse = null;      // 本次测量固定的椭圆 {cx,cy,rx,ry}(屏幕坐标)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function nextAfterChallenge() {
    if (SEC_CFG.enabled && SEC_CFG.screenReflect && !state.sec.reflectDone) runReflectChallenge();
    else beginSampling();
  }

  function faceBox() {
    return state.lastMetrics && state.lastMetrics.ok ? state.lastMetrics.box : null;
  }

  /** 中央椭圆几何:尺寸取窗口比例(默认 46%×66%),中心对齐预览画面中心并约束在画面内 */
  function computeEllipse() {
    const R = SEC_CFG.reflect || {};
    const wR = R.ellipseWRatio != null ? R.ellipseWRatio : 0.46;
    const hR = R.ellipseHRatio != null ? R.ellipseHRatio : 0.66;
    const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    const sr = els.stage.getBoundingClientRect();
    const cx = sr.width ? sr.left + sr.width / 2 : vw / 2;
    const cy = sr.height ? sr.top + sr.height / 2 : vh / 2;
    let rx = (vw * wR) / 2, ry = (vh * hR) / 2;
    // 椭圆不超出预览画面(否则「洞」盖到画面外,人脸反而被闪光直射)
    if (sr.width > 0 && sr.height > 0) {
      rx = Math.min(rx, sr.width * 0.48);
      ry = Math.min(ry, sr.height * 0.48);
    }
    return { cx, cy, rx: Math.max(40, rx), ry: Math.max(40, ry) };
  }

  function ensureFlashEl() {
    if (_flashEl && _flashEl.isConnected) return _flashEl;
    _flashEl = document.createElement('div');
    _flashEl.id = 'sec-flash-stage';
    // 固定铺满整个窗口(而非仅 4:3 预览区),光强更集中
    _flashEl.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;';
    (els.modal || document.body).appendChild(_flashEl);
    return _flashEl;
  }

  /** 除中央椭圆外整屏不透明遮罩:椭圆内透明(可见人脸),椭圆外为着色闪光 */
  function applyFlashHole() {
    const el = _flashEl;
    if (!el) return;
    const g = _ellipse || computeEllipse();
    const f = (SEC_CFG.reflect && SEC_CFG.reflect.ellipseFeather != null)
      ? SEC_CFG.reflect.ellipseFeather : 0.06;
    const inner = Math.max(0, Math.min(99, 100 - f * 100));
    const mask =
      `radial-gradient(ellipse ${g.rx.toFixed(0)}px ${g.ry.toFixed(0)}px ` +
      `at ${g.cx.toFixed(0)}px ${g.cy.toFixed(0)}px, ` +
      `rgba(0,0,0,0) ${inner.toFixed(0)}%, #000 100%)`;
    el.style.webkitMaskImage = mask;
    el.style.maskImage = mask;
    el.style.webkitMaskRepeat = 'no-repeat';
    el.style.maskRepeat = 'no-repeat';
  }

  function setFlashColor(color) {
    const el = ensureFlashEl();
    el.style.background = color;
    applyFlashHole();
  }

  function clearFlash() {
    if (_flashEl) { _flashEl.remove(); _flashEl = null; }
  }

  /** 刷新挖洞(测量期间 _ellipse 固定,避免洞跟随人脸抖动) */
  function updateReflectHole() {
    if (_flashEl && _flashEl.isConnected) applyFlashHole();
  }

  /** 显示中央椭圆准心帮助对准;text 为提示文案,bad=true 时用警示色 */
  function showGuide(text, bad) {
    if (text) _guideText = text;
    const g = _ellipse || computeEllipse();
    if (!_guideEl || !_guideEl.isConnected) {
      _guideEl = document.createElement('div');
      _guideEl.className = 'reflect-guide';
      const ring = document.createElement('i');
      ring.className = 'rg-ring';
      const t = document.createElement('b');
      t.className = 'rg-text';
      _guideEl.appendChild(ring);
      _guideEl.appendChild(t);
      (els.modal || document.body).appendChild(_guideEl);
    }
    const ring = _guideEl.querySelector('.rg-ring');
    ring.style.left = g.cx.toFixed(0) + 'px';
    ring.style.top = g.cy.toFixed(0) + 'px';
    ring.style.width = (g.rx * 2).toFixed(0) + 'px';
    ring.style.height = (g.ry * 2).toFixed(0) + 'px';
    const t = _guideEl.querySelector('.rg-text');
    t.textContent = _guideText || '';
    t.classList.toggle('bad', !!bad);
    t.style.left = g.cx.toFixed(0) + 'px';
    t.style.top = (g.cy + g.ry + 30).toFixed(0) + 'px';
  }

  function hideGuide() {
    if (_guideEl) { _guideEl.remove(); _guideEl = null; }
    _ellipse = null;
    _guideText = '';
  }

  /** 人脸中心(视频坐标→屏幕坐标,含水平镜像)是否落在中央椭圆内 */
  function faceInsideEllipse(box, margin = 0) {
    if (!box) return false;
    const g = _ellipse || computeEllipse();
    const sr = els.stage.getBoundingClientRect();
    const vw = els.video.videoWidth || 0, vh = els.video.videoHeight || 0;
    if (!sr.width || !vw || !vh) return false;
    const fx = sr.width / vw, fy = sr.height / vh;
    const cx = sr.left + sr.width - (box.x + box.width / 2) * fx;   // 水平镜像
    const cy = sr.top + (box.y + box.height / 2) * fy;
    const dx = (cx - g.cx) / g.rx;
    const dy = (cy - g.cy) / g.ry;
    return Math.hypot(dx, dy) <= (1 - margin);
  }

  async function reflectOnceMeasure() {
    const colors = ['rgb(255,70,70)', 'rgb(70,255,70)', 'rgb(70,70,255)'];
    const p = SEC_CFG.reflect || {};
    const perMs = p.perColorMs || 300;
    const settleMs = p.settleMs || 150;        // 闪色后等曝光/AWB 稳定
    const sampleGapMs = p.sampleGapMs || 60;
    const reps = p.samplesPerColor || 3;       // 每色连采帧数
    const sampleFr = p.sampleFraction || 0.5;
    const vw0 = els.video.videoWidth || 1, vh0 = els.video.videoHeight || 1;
    const lumOf = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const bgBox = { x: 0, y: 0, width: Math.floor(vw0 * 0.22), height: Math.floor(vh0 * 0.22) };
    const medOf = (arr) => (arr.length ? arr.slice().sort((a, b) => a - b)[arr.length >> 1] : 0);

    // 固定本次测量的椭圆;人脸不在椭圆内则不测量(闪光直射人脸会污染采样)
    _ellipse = computeEllipse();
    const margin = (p.insideMargin != null) ? p.insideMargin : 0.06;
    const b0 = faceBox();
    if (!b0 || !faceInsideEllipse(b0, margin)) {
      clearFlash();
      return { suspicious: false, reason: 'face-outside', avgBoost: 0, sel: 0, colors: 0 };
    }
    // 无光基线:开头和结尾各测一次取平均,抵消漂移
    const base0 = b0 ? sec.sampleFaceMeanRgb(els.video, b0, sampleFr) : null;
    const bg0 = sec.sampleFaceMeanRgb(els.video, bgBox, 1);
    const samples = [];          // 每色一个中位值
    const bgSamples = [];        // 每色背景中位值
    const subSamples = [];       // 每色 脸区4子块
    const logPerColor = [];      // 诊断用
    for (const c of colors) {
      setFlashColor(c);
      await sleep(settleMs);                 // 跳过颜色切换帧
      // 采样前确认人脸仍在椭圆内;若已移出则立即中止本次测量
      const bChk = faceBox();
      if (!bChk || !faceInsideEllipse(bChk, margin)) {
        clearFlash();
        return { suspicious: false, reason: 'face-outside', avgBoost: 0, sel: 0, colors: 0 };
      }
      const repsArr = [], bgArr = [], subArr = [];
      for (let k = 0; k < reps; k++) {
        const b = faceBox();
        const s = b ? sec.sampleFaceMeanRgb(els.video, b, sampleFr) : null;
        if (s) repsArr.push(s);
        bgArr.push(sec.sampleFaceMeanRgb(els.video, bgBox, 1));
        const bc = b || b0;
        if (bc) {
          const q = (ix, iy) => ({ x: Math.floor(bc.x + ix * bc.width / 2), y: Math.floor(bc.y + iy * bc.height / 2),
                                   width: Math.max(1, Math.floor(bc.width / 2)), height: Math.max(1, Math.floor(bc.height / 2)) });
          subArr.push([q(0, 0), q(1, 0), q(0, 1), q(1, 1)].map((qb) => sec.sampleFaceMeanRgb(els.video, qb, 1)));
        }
        await sleep(sampleGapMs);
      }
      clearFlash();
      if (repsArr.length) {
        const med = { r: medOf(repsArr.map((x) => x.r)), g: medOf(repsArr.map((x) => x.g)), b: medOf(repsArr.map((x) => x.b)) };
        samples.push(med);
        logPerColor.push({ color: c, med });
      }
      if (bgArr.length) bgSamples.push({ r: medOf(bgArr.map((x) => x.r)), g: medOf(bgArr.map((x) => x.g)), b: medOf(bgArr.map((x) => x.b)) });
      if (subArr.length) subSamples.push(subArr[subArr.length >> 1]);
    }
    clearFlash();
    const base1 = b0 ? sec.sampleFaceMeanRgb(els.video, b0, sampleFr) : null;
    const bg1 = sec.sampleFaceMeanRgb(els.video, bgBox, 1);

    if (!base0 || !base1 || samples.length < colors.length) {
      console.debug('[reflect] 采样不足', { base0, base1, n: samples.length });
      return { suspicious: true, avgBoost: 0, sel: 0, reason: 'no-sample', colors: samples.length };
    }
    const base = {
      r: (base0.r + base1.r) / 2,
      g: (base0.g + base1.g) / 2,
      b: (base0.b + base1.b) / 2,
    };
    const baseArr = [base.r, base.g, base.b];
    const bgBase = { r: (bg0.r + bg1.r) / 2, g: (bg0.g + bg1.g) / 2, b: (bg0.b + bg1.b) / 2 };
    const bgBaseArr = [bgBase.r, bgBase.g, bgBase.b];

    // 通道选择性:打红(i=0)→(R增量 - G/B平均增量)应明显为正
    // 真人:被打光的那个通道抬升,其它通道不大动 => sel 大
    // 屏幕脸:基本不随激励变 => sel≈0;打印纸:三通道一起涨 => sel≈0
    let selSum = 0, boostSum = 0, n = 0;
    samples.forEach((s, i) => {
      const arr = [s.r, s.g, s.b];
      const ch = arr[i] - baseArr[i];
      const otherNow = (arr[(i + 1) % 3] + arr[(i + 2) % 3]) / 2;
      const otherBase = (baseArr[(i + 1) % 3] + baseArr[(i + 2) % 3]) / 2;
      const sel = ch - (otherNow - otherBase);
      selSum += sel;
      boostSum += ch;
      n++;
    });
    const avgSel = n ? selSum / n : 0;
    const avgBoost = n ? boostSum / n : 0;
    const selThr = (p.selectivityThr != null) ? p.selectivityThr : 1.5;
    // 判据分两层:先看「有没有测到」——打光后目标通道必须出现可观测抬升;
    // 再看「响应有没有选择性」。旧代码把两者混在一起,导致测量失败(avgBoost≈0)
    // 时 avgSel 也≈0,被当成「屏幕」而误拒真人(实测里就有 avgBoost=0.1 判 suspicious 的记录)。
    const boostFloor = (p.boostFloor != null) ? p.boostFloor : 1.0;
    const measured = n > 0 && avgBoost >= boostFloor;
    const suspicious = measured && (avgSel < selThr);
    // ===== 屏幕判据(仅测量,暂不改判定)=====
    const selfEmit = (bgBase && lumOf(bgBase) > 1) ? (lumOf(base) / lumOf(bgBase)) : 0;
    let bgSelSum = 0, bgN = 0;
    bgSamples.forEach((s, i) => {
      const arr = [s.r, s.g, s.b];
      const ch = arr[i] - bgBaseArr[i];
      const oN = (arr[(i + 1) % 3] + arr[(i + 2) % 3]) / 2;
      const oB = (bgBaseArr[(i + 1) % 3] + bgBaseArr[(i + 2) % 3]) / 2;
      bgSelSum += ch - (oN - oB); bgN++;
    });
    const avgBgSel = bgN ? bgSelSum / bgN : 0;
    let uniCV = 0;
    if (subSamples.length && subSamples[0]) {
      const gains = subSamples[0].map((c) => c.r - baseArr[0]);
      const mean = gains.reduce((a, b) => a + b, 0) / gains.length;
      const va = gains.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gains.length;
      uniCV = mean !== 0 ? Math.sqrt(va) / Math.abs(mean) : 0;
    }
    console.debug('[reflect-screen] selfEmit=', +selfEmit.toFixed(2),
      'bgSel=', +avgBgSel.toFixed(2), 'uniCV=', +uniCV.toFixed(2),
      'base=', base, 'bg=', bgBase);

    console.debug('[reflect] base=', base, 'perColor=', logPerColor,
      'avgBoost=', +avgBoost.toFixed(2), 'avgSel=', +avgSel.toFixed(2),
      'selThr=', selThr, 'boostFloor=', boostFloor,
      '=>', !measured ? 'no-response' : (suspicious ? 'suspicious' : 'ok'));
    if (!measured) {
      // 没测到响应 => 测量无效,而不是「疑似屏幕」。不据此拦人,交调用方重试,
      // 避免把「打光没打到脸/采样区偏了」这类问题变成对真人的误拒。
      return { suspicious: false, reason: 'no-response', avgBoost: +avgBoost.toFixed(1),
               sel: +avgSel.toFixed(2), colors: n };
    }
    return { suspicious, avgBoost: +avgBoost.toFixed(1), sel: +avgSel.toFixed(2), selfEmit: +selfEmit.toFixed(2), bgSel: +avgBgSel.toFixed(2), uniCV: +uniCV.toFixed(2), reason: suspicious ? 'low-selectivity' : 'ok', colors: n };
  }

  /** 屏幕反射挑战(拦截判定):动作活体通过后执行 */
  async function runReflectChallenge() {
    state.sec.reflectDone = true;
    state.phase = 'reflect';
    els.action.disabled = true;
    els.actionLabel.textContent = '反射检测中…';
    const R = SEC_CFG.reflect || {};
    // 顶层 SECURITY.enforceGates 是总开关:默认 false → 可疑只记 hints/上报告警,
    // 不中断认证(见 config.js 的说明)。恢复硬拦需同时打开总开关与单项开关。
    const gate = !!SEC_CFG.enforceGates && !!R.enforceGate;
    const maxTries = Math.max(1, R.tries || 2);
    const alignTries = Math.max(1, R.alignTries || 6);
    const onAlignFail = R.onAlignFail || 'reject';
    const onNoResponse = R.onNoResponse || 'reject';

    showGuide('请将脸对准中央椭圆内');

    let result = null;
    let attempt = 0, miss = 0;      // miss:未对准 / 未测到响应,两者都不计入正式尝试
    while (attempt < maxTries) {
      attempt += 1;
      setCommand(`屏幕反射检测 ${attempt}/${maxTries}`, '');
      setTip('请保持面部不动:椭圆以外区域将闪烁 红/绿/蓝。请勿用屏幕/照片播放人脸。');
      setStateText('反射活体检测 · 请保持不动', 'warn');
      result = await reflectOnceMeasure();

      if (result.reason === 'face-outside' || result.reason === 'no-response') {
        // 没测量成功:分别给出提示,不计入正式尝试,也绝不据此拦人
        miss += 1;
        attempt -= 1;
        if (miss >= alignTries) break;
        if (result.reason === 'face-outside') {
          showGuide('请把脸移到中央椭圆内', true);
          setCommand('未对准 · 请调整位置', 'warn');
          setStateText('请把脸移到中央椭圆内再开始检测', 'warn');
        } else {
          showGuide('未测到光学响应 · 请正对镜头', true);
          setCommand('未测到响应 · 请正对镜头', 'warn');
          setStateText('未测到光学响应:请正对镜头,并避开遮挡与反光物后重试', 'warn');
        }
        await sleep(600);
        continue;
      }
      showGuide('检测中,请保持不动');
      if (!result.suspicious) break;
      if (attempt < maxTries) {
        setStateText('未检测到皮肤反射:请正对镜头、移除遮挡,即将自动重试…', 'warn');
        setCommand('未通过 · 重试', 'warn');
        await sleep(1000);
      }
    }

    hideGuide();

    // 始终没测成(未对准 / 无有效响应):按配置决定跳过还是拒绝
    if (result && (result.reason === 'face-outside' || result.reason === 'no-response')) {
      const notAligned = result.reason === 'face-outside';
      // 两种"没测成"分别取策略:未对准是姿势问题,无响应更可疑(重放画面在变,
      // 差分测量容易失效)。默认都 reject,避免"测量失败即可绕过"。
      const policy = notAligned ? onAlignFail : onNoResponse;
      state.sec.reflect = null;
      state.sec.hints.push({
        type: 'reflect_skipped',
        reason: notAligned ? 'face-not-aligned' : 'no-response',
        policy,
      });
      if (policy === 'reject') {
        setCommand('反射活体未通过', 'warn');
        setStateText(notAligned ? '已拒绝:未将人脸对准中央椭圆'
                                : '已拒绝:未测到光学响应', 'warn');
        settle({
          ok: false, reason: 'spoof',
          liveness: state.challenge ? state.challenge.summary() : undefined,
          spoofHint: notAligned ? 'reflect_not_aligned' : 'reflect_no_response',
        });
        return;
      }
      console.debug('[reflect] 始终未测量成功,已跳过色光检测:', result.reason);
      setCommand('', '');
      setStateText('未测到有效响应,已跳过色光检测', 'warn');
      beginSampling();
      return;
    }

    state.sec.reflect = result;
    if (result && result.suspicious) {
      state.sec.hints.push({
        type: 'screen_reflect', suspicious: true,
        avgBoost: result.avgBoost, dom: result.dom,
      });
    }

    if (result && result.suspicious && gate) {
      setCommand('反射活体未通过', 'warn');
      setStateText('已拒绝:疑似屏幕/照片/视频重放', 'warn');
      settle({
        ok: false, reason: 'spoof',
        liveness: state.challenge ? state.challenge.summary() : undefined,
      });
      return;
    }
    setCommand('', '');
    beginSampling();
  }

  function collectSecSamples(m, now) {
    // 姿态样本(评估轨迹跳变)
    if (SEC_CFG.enabled && SEC_CFG.poseContinuity) {
      const s = state.sec.poseSamples;
      s.push({ t: now, yaw: m.yaw, pitch: m.pitch, roll: m.roll || 0 });
      if (s.length > 400) s.splice(0, s.length - 400);
    }
    // 局部形变样本:仅眨眼/张嘴动作期间缓存小灰度帧 + 局部框
    if (SEC_CFG.enabled && SEC_CFG.localDeform && state.challenge && state.challenge.current) {
      const k = state.challenge.current.key;
      if (k === 'open_mouth') {
        try {
          const g = sec.grayVideo(els.video, 48, 36);
          const vw = els.video.videoWidth, vh = els.video.videoHeight;
          if (vw > 0 && vh > 0) {
            const rects = computeRoiRects(m.landmarks, vw, vh, 48, 36);
            state.sec.ring.push({ t: now, g, ear: m.ear, mar: m.mar, rects });
            while (state.sec.ring.length > 12) state.sec.ring.shift();
          }
        } catch (e) { /* 采样失败忽略 */ }
      }
    }
  }

  /** 由 68 点算眼/嘴 ROI 并缩放到小灰度图坐标 */
  function computeRoiRects(pts, vw, vh, sw, sh) {
    const fxs = sw / vw, fys = sh / vh;
    const box = (idxs) => {
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const i of idxs) {
        const p = pts[i]; if (!p) continue;
        minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
        miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
      }
      const r = { x: minx * fxs, y: miny * fys, w: (maxx - minx) * fxs + 2, h: (maxy - miny) * fys + 2 };
      return r;
    };
    const eyes = box([36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]);
    const mouth = box(Array.from({ length: 20 }, (_, i) => 48 + i)); // 48..67
    return { eyes, mouth };
  }

  /** 动作完成时评估局部形变(眼/嘴 ROI 变化 vs 全脸),低则加软提示 */
  function evalLocalDeform(key) {
    try {
      const ring = state.sec.ring;
      if (ring.length < 3) return;
      const now = performance.now();
      const isMouth = key === 'open_mouth';
      const newest = ring[ring.length - 1];
      const recent = ring.filter((s) => now - s.t <= 700);
      if (!recent.length) return;
      // B: 动作极值帧(闭眼最甚 / 张嘴最大),否则取最新
      let B = newest;
      for (let i = recent.length - 1; i >= 0; i--) {
        const s = recent[i];
        if (isMouth ? s.mar > 0.30 : s.ear < 0.22) { B = s; break; }
      }
      // A: 动作前的对照帧(眼睁开 / 嘴闭合)
      let A = null;
      for (const s of ring) {
        if (s.t >= B.t - 5) continue;
        const gap = B.t - s.t;
        if (gap < 80 || gap > 900) continue;
        if (isMouth ? s.mar < 0.20 : s.ear > 0.26) { A = s; break; }
      }
      if (!A) A = ring[0];
      const roi = isMouth ? B.rects.mouth : B.rects.eyes;
      const ratio = sec.localVsWholeRatio(A.g, B.g, roi);
      if (ratio !== null && ratio < SEC_CFG.deform.minRatio) {
        state.sec.hints.push({ type: 'local_deform', key, ratio: +ratio.toFixed(2), suspicious: true });
        // 直接拦截:疑似贴纸/打印遮挡导致眼/嘴无真实局部形变
        // (受顶层 SECURITY.enforceGates 约束;默认只告警不阻断)
        if (SEC_CFG.enforceGates && SEC_CFG.deform && SEC_CFG.deform.enforceGate && !state.closed) {
          setCommand('活体未通过', 'warn');
          setStateText('检测到异常:疑似贴纸/打印遮挡(无局部形变),已拒绝', 'warn');
          settle({
            ok: false, reason: 'spoof',
            liveness: state.challenge ? state.challenge.summary() : undefined,
            spoofHint: 'local_deform',
          });
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 汇总安全软信号(供 wizard 结果附带,写入告警) */
  function secSummary() {
    let pose = null;
    try {
      if (SEC_CFG.enabled && SEC_CFG.poseContinuity) {
        pose = sec.assessPoseJump(state.sec.poseSamples, {
          maxJumpNorm: (SEC_CFG.pose && SEC_CFG.pose.maxJump) || 0.45,
          maxJumpDeg: (SEC_CFG.pose && SEC_CFG.pose.maxRollDeg) || 28,
          minSamples: (SEC_CFG.pose && SEC_CFG.pose.minSamples) || 5,
        });
        if (pose.suspicious && !state.sec.hints.some((h) => h.type === 'pose_jump')) {
          state.sec.hints.push({
            type: 'pose_jump', suspicious: true,
            maxYaw: pose.maxYaw, maxPitch: pose.maxPitch, maxRoll: Math.round(pose.maxRoll),
          });
        }
      }
    } catch (e) { /* 忽略 */ }
    return { hints: state.sec.hints.slice(), reflect: state.sec.reflect, pose };
  }

  /* ============ 活体挑战阶段 ============ */
  function beginChallenge() {
    setPhase('challenge');
    const sc = state.sec;
    sc.hints = []; sc.poseSamples = []; sc.ring = [];
    sc.reflect = null; sc.reflectDone = false; sc.probeBusy = false; sc.prevDone = -1;
    state.challenge = createLiveness({ mode });
    renderChips(challengeChips(state.challenge.snapshot()));
    updateChallengeUI(state.challenge.snapshot(), null, performance.now());
    els.action.disabled = true;
    els.actionLabel.textContent = '请完成动作';
    refitSoon();
  }

  function updateChallengeUI(snap, m, now) {
    setStateText(`活体挑战 ${snap.done + 1}/${snap.total} · 请跟随指示`, m && m.ok ? 'good' : 'warn');
    if (snap.current && snap.current.label !== state.lastInstruction) {
      setCommand(snap.current.label, '');
      state.lastInstruction = snap.current.label;
    }
    if (state.lastInstruction) {
      setTip(`请在镜头前完成动作:${state.lastInstruction}。完成后将自动进入下一步。`);
    }
    // 晃动/倾斜门控:人脸晃动明显或歪头过大时暂停眨眼/张嘴判定
    if (snap.status === 'moving') {
      setStateText('检测到面部晃动或歪头 · 已暂停判定,请保持头部端正', 'warn');
      setTip(`请先保持头部端正、面部静止,再${state.lastInstruction || snap.current.label}。`);
      els.lvDot.className = 'lv-dot warn';
      renderChips(challengeChips(snap));
      return;
    }
    // 动作进行中的实时反馈(帮助用户了解判定是否在看)
    if (m && m.ok && snap.current) {
      const k = snap.current.key;
      if (k === 'open_mouth') {
        if (m.mar > 0.32) setStateText('已检测到张嘴 ✓', 'good');
      } else if (k === 'shake_head') {
        setStateText(`摇头幅度 |yaw|=${Math.abs(m.yaw).toFixed(2)}`, Math.abs(m.yaw) > 0.2 ? 'good' : 'warn');
      } else if (k === 'nod') {
        setStateText(`点头幅度 |pitch|=${Math.abs(m.pitch).toFixed(2)}`, Math.abs(m.pitch) > 0.16 ? 'good' : 'warn');
      }
    }
    if (!m || !m.ok) {
      if (m && (m.reason === 'no-face' || m.reason === 'too-small')) {
        els.lvDot.className = 'lv-dot warn';
        els.stateText.textContent = '未检测到人脸,请面向摄像头';
      }
    }
    renderChips(challengeChips(snap));
  }

  /* ============ 姿态采样阶段 ============ */
  function beginSampling() {
    if (state.closed) return;
    setPhase('sample');
    state.stepIndex = 0;
    state.samples = [];
    state.goingSample = false;
    state.autoArmedAt = 0;
    els.action.disabled = false;
    setStepUI(0);
    setStateText('活体挑战通过 · 正在采集人脸样本', 'good');
    refitSoon();
  }

  function setStepUI(i) {
    state.stepIndex = i;
    const pose = poses[i];
    if (!pose) return;
    renderChips(poseChips());
    els.actionLabel.textContent = mode === 'verify' ? '拍摄 · 开始比对' : `拍摄 · ${pose.label}`;
    if (mode === 'verify') {
      setTip('请保持正面,将自动采集(也可点击按钮)…');
    } else {
      setTip(`请按指示调整头部:${pose.label},然后点击“拍摄”。`);
    }
  }

  function updateSampleUI(m, now) {
    if (!poses[state.stepIndex]) return;
    if (state.bursting) return;    // 采集 / 静息窗进行中,提示语由采集流程控制
    if (m && m.ok) {
      // 给正脸/左右姿态做实时引导
      if (mode === 'enroll') {
        const pose = poses[state.stepIndex];
        if (pose.key === 'front') {
          if (Math.abs(m.yaw) < 0.18) setStateText('正脸已就位 · 可拍摄', 'good');
          else setStateText('请将头部转正', 'warn');
        } else if (pose.key === 'left') {
          if (m.yaw > 0.24) setStateText('已检测到向左转头 · 可拍摄', 'good');
          else setStateText('请轻微向左转头', 'warn');
        } else if (pose.key === 'right') {
          if (m.yaw < -0.24) setStateText('已检测到向右转头 · 可拍摄', 'good');
          else setStateText('请轻微向右转头', 'warn');
        }
      } else if (mode === 'verify') {
        // 正面稳定即自动采集一次
        if (state.stepIndex === 0 && Math.abs(m.yaw) < 0.18) {
          if (!state.autoArmedAt) state.autoArmedAt = now;
          if (now - state.autoArmedAt > 700) {
            state.autoArmedAt = 0;
            captureStep();
          }
        } else {
          state.autoArmedAt = 0;
          setStateText('请保持正对摄像头', Math.abs(m.yaw) < 0.18 ? 'good' : 'warn');
        }
      }
    } else if (m && (m.reason === 'no-face' || m.reason === 'too-small')) {
      setStateText('未检测到人脸,请面向摄像头', 'warn');
    }
  }

  /** verify 模式:先采 ~14 帧正面帧(比对用),再采一段静息观察窗(时序反回放用) */
  function runVerifyBurst() {
    if (state.closed || state.phase !== 'sample' || state.bursting) return;
    state.bursting = true;
    state.verifyFrames = [];
    state.captureT0 = performance.now();
    els.action.disabled = true;
    setStateText('正在采集多帧序列,请保持正对镜头…', 'good');
    const maxFrames = 14;
    const intervalMs = 90;
    const timeoutMs = 2600;
    const start = Date.now();
    const tick = () => {
      if (state.closed || state.phase !== 'sample') { runTemporalWindow(); return; }
      const m = state.lastMetrics;
      if (m && m.ok && m.landmarks && m.landmarks.length === 68 &&
          Math.abs(m.yaw) < 0.18) {
        pushVerifyFrame(m, CFG.CAMERA.UPLOAD_MAX_SIDE || 640);
      }
      if (state.verifyFrames.length >= maxFrames || Date.now() - start > timeoutMs) {
        runTemporalWindow();
      } else {
        setTimeout(tick, intervalMs);
      }
    };
    tick();
  }

  /** 采一帧(整帧、不裁剪不镜像)+ 脸框 + 68 点 + 真实时间戳 */
  function pushVerifyFrame(m, maxSide) {
    const vw = els.video.videoWidth || 1;
    const cap = captureFullFrame(els.video, maxSide, CFG.CAMERA.jpegQuality);
    const s = cap.w / vw;
    state.verifyFrames.push({
      image: cap.dataUrl,
      face: {
        x: Math.round(m.box.x * s),
        y: Math.round(m.box.y * s),
        width: Math.round(m.box.width * s),
        height: Math.round(m.box.height * s),
      },
      landmarks: scalePoints(m.landmarks, s),
      // 真实时间戳(相对采集起点 ms):服务端据此算 clip 跨度,不再硬编码 i*40
      ts: Math.round(performance.now() - state.captureT0),
    });
  }

  /**
   * 静息观察窗:模块三的冻结/眨眼判据需要一段「基本静止且时长足够」的序列,
   * 而挑战刚结束时用户还在动,那一段帧没有判定价值,故单独采并给出引导语。
   */
  function runTemporalWindow() {
    const T = (CFG.CAMERA && CFG.CAMERA.TEMPORAL) || {};
    const windowMs = Math.max(0, T.windowMs != null ? T.windowMs : 5000);
    if (T.enabled === false || windowMs < 500) { finishCapture(); return; }
    const gapMs = Math.max(40, Math.round(1000 / (T.fps || 10)));
    const maxYaw = T.maxYaw != null ? T.maxYaw : 0.35;
    const maxSide = T.maxSide || CFG.CAMERA.UPLOAD_MAX_SIDE || 640;

    setCommand('时序活体检测中 · 保持不动', '');
    setStateText('请保持自然静止,注视镜头', 'good');
    // 注意:服务端若采用严格策略(只有 LIVE 放行),活体判定必须拿到「观察窗内
    // 至少一次自然眨眼」才可能通过,所以这里明确提示眨眼,否则真人会被拒。
    setTip('马上就好:请自然注视镜头并保持不动,过程中自然眨眼 1~2 次(活体判定需要)。');
    els.actionLabel.textContent = '判定中…';

    const endAt = Date.now() + windowMs;
    const step = () => {
      if (state.closed || state.phase !== 'sample') { finishCapture(); return; }
      const m = state.lastMetrics;
      if (m && m.ok && m.landmarks && m.landmarks.length === 68 &&
          Math.abs(m.yaw) < maxYaw) {
        pushVerifyFrame(m, maxSide);
      }
      if (Date.now() >= endAt) finishCapture();
      else setTimeout(step, gapMs);
    };
    step();
  }

  /** 采集会话收尾(正面帧 + 静息窗均已结束) */
  function finishCapture() {
    if (!state.bursting) return;
    state.bursting = false;
    if (state.closed) return;
    if (!state.verifyFrames.length) {
      setStepUI(state.stepIndex);          // 还原按钮文案与提示
      setTip('未能采集到清晰人脸,请重试');
      els.action.disabled = false;
      setStateText('请保持正对摄像头', 'warn');
      return;
    }
    setCommand('采集完成,正在处理…', 'ok');
    setStateText('样本采集完成', 'good');
    settle({
      ok: true,
      samples: state.verifyFrames.map((f) => f.image),
      frames: state.verifyFrames,
      liveness: state.challenge ? state.challenge.summary() : undefined,
    });
  }

  function captureStep() {
    if (!state.stream || !els.video.videoWidth || state.phase !== 'sample') return;
    if (state.closed) return;
    const cur = state.lastMetrics;
    if (!cur || !cur.ok) {
      setTip('未检测到清晰人脸,请将面部置于框内后重试');
      return;
    }
    els.action.disabled = true;
    if (mode === 'verify') { runVerifyBurst(); return; }
    try {
      const dataUrl = captureFrame(els.video, CFG.CAMERA.sampleSize, CFG.CAMERA.jpegQuality);
      const pose = poses[state.stepIndex];
      state.samples.push({ poseKey: pose.key, label: pose.label, dataUrl });

      const next = state.stepIndex + 1;
      if (next < poses.length) {
        setStepUI(next);
        setTip(`已采集「${pose.label}」。`);
      } else {
        setCommand('采集完成,正在处理…', 'ok');
        setStateText('样本采集完成', 'good');
        later(() => finishSuccess(), 420);
        return;
      }
    } finally {
      if (!state.closed && state.phase === 'sample') later(() => { els.action.disabled = false; }, 350);
    }
  }

  function finishSuccess() {
    if (state.challenge) {
      settle({
        ok: true,
        samples: state.samples.map((s) => s.dataUrl),
        liveness: state.challenge.summary(),
      });
    } else {
      settle({ ok: true, samples: state.samples.map((s) => s.dataUrl) });
    }
  }

  /* ============ 事件 ============ */
  function bindActions() {
    els.action.onclick = () => captureStep();
    const closeFn = () => settle({ ok: false, reason: 'cancelled' });
    els.cancel.onclick = closeFn;
    els.close.onclick = closeFn;
    state.onKey = (e) => { if (e.key === 'Escape') closeFn(); };
    document.addEventListener('keydown', state.onKey);
  }

  function setStageOff(msg) {
    els.stage.classList.add('cam-off');
    els.stateText.textContent = msg;
    els.lvDot.className = 'lv-dot warn';
  }

  return {
    open,
    close: (r) => settle(r),
  };
}

/* ================= 工具 ================= */
function waitForVideo(video, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && video.videoWidth) return resolve();
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, timeoutMs);
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

/** 从视频帧居中裁剪正方形并镜像(与预览一致),编码 JPEG dataURL。 */
function captureFrame(video, size, quality) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.translate(size, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', quality);
}

/** 采集整帧(不裁剪、不镜像),用于多帧时序认证。返回 {dataUrl,w,h,sc} */
function captureFullFrame(video, maxSide, quality) {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const sc = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * sc));
  const h = Math.max(1, Math.round(vh * sc));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), w, h, sc };
}
/** 68 点按缩放比展平为 136 个数 */
function scalePoints(pts, sc) {
  const a = [];
  for (const p of pts) a.push(+(p.x * sc).toFixed(2), +(p.y * sc).toFixed(2));
  return a;
}