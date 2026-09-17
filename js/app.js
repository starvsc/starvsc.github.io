/**
 * 应用主逻辑:视图切换 / 表单校验 / 登录注册编排
 *
 * 认证流程(双因子):
 *   登录   :账号 + 密码 →(通过)→ 摄像头人脸活体验证 → 进入系统
 *   注册   :账号信息(第1步)→ 摄像头采集 正/左/右 人脸样本(第2步)→ 提交
 *
 * 说明:当前 mock 模式下人脸比对结果为“模拟通过”,切换 CFG.API_MODE='http'
 *       后即调用真实后端 /api/v1/face/verify。
 */
import { CFG } from './config.js';
import { api } from './api.js';
import * as store from './store.js';
import { openCameraWizard } from './camera.js';

const $ = (id) => document.getElementById(id);

/* ================= 状态 ================= */
const S = {
  enrollSamples: [],   // 注册阶段采集的人脸样本 dataURL
  enrollLiveness: null, // 注册阶段活体挑战结果(提交给后端)
  enrollSpoof: null,    // 注册阶段安全软信号(spoof hints)
  busy: false,
};

/* ================= 工具 ================= */
function val(id) {
  return $(id).value.trim();
}

function showErr(id, msg) {
  const el = $(id);
  el.textContent = msg || '';
}

/** 显示/隐藏「模块三(时序活体)判定」字段;传空即隐藏 */
function showVerdict(verdict, note) {
  const el = $('login-verdict');
  if (!el) return;
  const text = String(verdict || '').trim();
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = note
    ? `时序活体判定:${text}(辅助信息:${note})`
    : `时序活体判定:${text}`;
}

function markInvalid(inputId, on) {
  $(inputId).closest('.field').classList.toggle('invalid', !!on);
}

function setBusy(btn, busy, busyText) {
  const label = btn.querySelector('.btn-label');
  const spin = btn.querySelector('.spinner');
  btn.disabled = busy;
  if (spin) spin.hidden = !busy;
  if (busy && busyText) label.textContent = busyText;
  if (!busy) label.textContent = btn.dataset.label || label.textContent;
}

function toast(msg, type = 'info') {
  const root = $('toast-root');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const icons = { success: '✓', error: '✕', info: 'i' };
  t.innerHTML = `<span class="t-ic">${icons[type] || 'i'}</span><span>${msg}</span>`;
  root.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 3200);
}

/* ================= 安全告警上报(需求7,最佳努力不阻塞) ================= */
function reportSecurity(evt) {
  if (CFG.SECURITY && !CFG.SECURITY.enabled) return;
  try { api.securityReport(evt).catch(() => {}); } catch (e) { /* ignore */ }
}

function buildSecEvent({ username = '-', decision = 'watch', wiz = null, type, extra }) {
  const hints = (wiz && wiz.spoof && wiz.spoof.hints) || [];
  return {
    event_type: type || 'liveness',
    username,
    challenge_id: (wiz && wiz.liveness && wiz.liveness.challengeId) || '',
    channel: 'frontend',
    decision,
    score: extra && extra.score != null ? extra.score : null,
    detail: {
      liveness: (wiz && wiz.liveness) || null,
      spoof: (wiz && wiz.spoof) || null,
      spoofHints: hints,
      reason: (wiz && wiz.reason) || null,
      ...((extra && extra.detail) || {}),
    },
  };
}

/* ================= 视图/页签 ================= */
function switchAuthTab(tab) {
  document.querySelectorAll('[data-auth-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.authTab === tab);
    b.setAttribute('aria-selected', b.dataset.authTab === tab ? 'true' : 'false');
  });
  $('form-login').hidden = tab !== 'login';
  $('form-register').hidden = tab !== 'register';
  if (tab === 'register') resetRegisterToStep(1);
}

function showLanding(user, faceInfo) {
  $('view-auth').hidden = true;
  $('view-landing').hidden = false;
  $('landing-user').textContent = user.displayName || user.username;
  // 识别耗时 / 模式标记
  const badges = document.querySelectorAll('#view-landing .landing-badges .badge');
  badges[0].textContent = api.isSimulated() ? '人脸比对 通过(模拟)' : '人脸比对 通过';
  badges[1].textContent = '活体检测 通过(动作)';
  const el = document.querySelector('.landing-badges .badge.muted');
  if (faceInfo && faceInfo.elapsedMs != null) {
    el.textContent = `识别耗时 ${(faceInfo.elapsedMs / 1000).toFixed(2)} s`;
  }
}

function showAuth() {
  $('view-auth').hidden = false;
  $('view-landing').hidden = true;
}

/* ================= 注册(两步) ================= */
function gotoRegStep(n) {
  document.querySelectorAll('[data-rstep]').forEach((d) => { d.hidden = d.dataset.rstep !== String(n); });
  [1, 2].forEach((i) => {
    const chip = document.querySelector(`[data-rstep-chip="${i}"]`);
    chip.classList.toggle('active', i === n);
    chip.classList.toggle('done', i < n);
  });
}

function resetRegisterToStep(step) {
  S.enrollSamples = [];
  S.enrollLiveness = null;
  S.enrollSpoof = null;
  renderThumbs([]);
  $('reg-submit').disabled = true;
  showErr('reg-error-s1', '');
  showErr('reg-error-s2', '');
  ['reg-username', 'reg-display', 'reg-password', 'reg-confirm'].forEach((i) => markInvalid(i, false));
  gotoRegStep(step || 1);
}

function validateRegStep1() {
  const username = val('reg-username');
  const pw = val('reg-password');
  const cf = val('reg-confirm');
  let bad = false;
  if (username.length < 4 || username.length > 20 || !/^[A-Za-z0-9_]+$/.test(username)) {
    markInvalid('reg-username', true); bad = true;
  } else markInvalid('reg-username', false);

  const pwBad = pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw);
  markInvalid('reg-password', pwBad); if (pwBad) bad = true;
  const cfBad = cf !== pw || cf.length === 0;
  markInvalid('reg-confirm', cfBad); if (cfBad) bad = true;

  return !bad;
}

function pwLevel(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (pw.length >= 12) s++;
  return s; // 0-4
}

function updateStrength(pw) {
  const box = $('pw-strength');
  const lv = pwLevel(pw);
  box.className = 'strength' + (pw ? ' lv' + lv : '');
  box.querySelector('span').textContent = ['', '弱', '中', '强', '很强'][lv];
}

/* 渲染三个样本缩略框 */
const THUMB_LABELS = [
  { pos: '正面', label: '正面' },
  { pos: '左侧', label: '向左转头' },
  { pos: '右侧', label: '向右转头' },
];

function makeThumbPlaceholder(pos) {
  return `
    <div class="thumb placeholder">
      <svg viewBox="0 0 48 48"><circle cx="24" cy="21" r="7" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M14 32c2-4 5.6-6 10-6s8 2 10 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
      <span>${pos}</span>
    </div>`;
}

function renderThumbs(samples) {
  const box = $('reg-thumbs');
  box.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const meta = THUMB_LABELS[i];
    if (samples[i]) {
      const d = document.createElement('div');
      d.className = 'thumb filled';
      d.innerHTML = `
        <img src="${samples[i]}" alt="${meta.label}"/>
        <span>${meta.label}</span>
        <span class="chk"><svg viewBox="0 0 12 12"><path d="M2 6l3 3 5-6" fill="none"/></svg></span>`;
      box.appendChild(d);
    } else {
      box.insertAdjacentHTML('beforeend', makeThumbPlaceholder(meta.pos));
    }
  }
}

/* ================= 登录 ================= */
async function onLogin(e) {
  e.preventDefault();
  if (S.busy) return;
  showErr('login-error', '');
  showVerdict('');

  const username = val('login-username');
  const password = $( 'login-password').value;
  if (!username) { showErr('login-error', '请输入账号'); markInvalid('login-username', true); return; }
  markInvalid('login-username', false);
  if (!password) { showErr('login-error', '请输入密码'); markInvalid('login-password', true); return; }
  markInvalid('login-password', false);

  S.busy = true;
  const btn = $('login-submit');
  btn.dataset.label = '登 录';
  setBusy(btn, true, '正在校验账号…');

  try {
    const res = await api.login({ username, password });
    if (!res.ok) {
      showErr('login-error', res.message);
      toast(res.message, 'error');
      return;
    }
    // 真实后端模式:若该账号还没录入人脸样本,先提醒去注册
    if (!api.isSimulated() && res.data && res.data.faceRegistered === false) {
      showErr('login-error', '该账号尚未录入人脸,请先完成注册(含人脸采集)');
      return;
    }

    // 人脸认证阶段(关键点检测 + 动作活体 + 采集)
    setBusy(btn, false, '');
    setBusy(btn, true, '正在发起人脸认证…');
    const wiz = await openCameraWizard({ mode: 'verify' });
    if (!wiz.ok) {
      if (wiz.reason === 'cancelled') return;
      if (wiz.reason === 'liveness') {
        reportSecurity(buildSecEvent({
          username: res.data.username, wiz, decision: 'reject', type: 'liveness_fail',
        }));
      }
      if (wiz.reason === 'spoof') {
        reportSecurity(buildSecEvent({
          username: res.data.username, wiz, decision: 'reject', type: 'spoof_reject',
        }));
        const sm = '未通过活体防伪检测(疑似屏幕重放/照片/贴纸遮挡),已拒绝本次认证并记录';
        showErr('login-error', sm);
        toast(sm, 'error');
        return;
      }
      let msg = '人脸认证未能完成:摄像头不可用或人脸模型加载失败';
      if (wiz.reason === 'liveness') {
        const lf = wiz.liveness && wiz.liveness.failReason;
        msg = lf === 'timeout'
          ? '活体动作超时:请按提示 眨眼/张嘴/摇头,并保持面部在框内后重试'
          : lf === 'no-face'
            ? '挑战期间未持续检测到人脸:请正对摄像头、调整距离与光线后重试'
            : '活体检测未通过(疑似照片/视频重放),已拒绝本次认证并记录';
      }
      showErr('login-error', msg);
      toast(msg, 'error');
      return;
    }

    setBusy(btn, true, '正在进行活体判定与人脸比对…');
    const useFrames = Array.isArray(wiz.frames) && wiz.frames.length > 0;
    const v = await api.faceVerify({
      username: res.data.username,
      frames: useFrames ? wiz.frames : undefined,
      image: useFrames ? undefined : (wiz.samples[0] || undefined),
      liveness: wiz.liveness,   // 前端活体挑战记录,后端可审计/告警
    });
    if (v.ok && v.data.passed) {
      const session = store.setSession(res.data);
      showLanding(res.data, v.data);
      toast(`认证成功,欢迎 ${session.displayName}`, 'success');
      reportSecurity(buildSecEvent({
        username: res.data.username, wiz, decision: 'allow', type: 'verify_pass',
        extra: { score: v.data.score != null ? v.data.score : null, detail: { passed: true } },
      }));
      const hints = (wiz.spoof && wiz.spoof.hints) || [];
      if (hints.length) {
        reportSecurity(buildSecEvent({
          username: res.data.username, wiz, decision: 'watch', type: 'spoof_suspect',
          extra: { detail: { hints } },
        }));
      }
    } else {
      // 拒绝路径:后端返回 spoof / 活体未通过 / 人脸比对失败
      const d = v.data || {};
      let msg = '人脸比对未通过';
      if (d.spoof) msg = '检测到疑似欺骗攻击(照片/视频),已拒绝认证并记录';
      else if (d.reason) msg = d.reason;          // 多帧路径的真实原因在这里
      else if (v.message && v.message !== 'ok') msg = v.message;

      // 模块三(时序活体)判定字段:INCONCLUSIVE / INSUFFICIENT / SPOOF 都直接展示
      let note = '';
      if (d.temporal_sufficient === false) note = `观察窗仅 ${d.clip_span_ms || 0}ms(需 ≥2000ms)`;
      else if (d.blink_count === 0) note = '观察窗内未检测到眨眼';
      showVerdict(d.temporal_verdict, note);

      if (d.spoof || d.pad_attack ||
          (d.temporal_verdict && d.temporal_verdict !== 'LIVE')) toast(msg, 'error');
      showErr('login-error', msg);
      reportSecurity(buildSecEvent({
        username: res.data.username, wiz, decision: 'reject', type: 'verify_reject',
        extra: {
          score: d.score != null ? d.score : null,
          detail: {
            backendMsg: d.reason || v.message || '',
            temporalVerdict: d.temporal_verdict || '',
            temporalPolicy: d.temporal_policy || '',
            temporalSufficient: d.temporal_sufficient !== false,
            clipSpanMs: d.clip_span_ms || 0,
            blinkCount: d.blink_count || 0,
          },
        },
      }));
    }
  } finally {
    S.busy = false;
    setBusy(btn, false, '');
  }
}

/* ================= 注册 ================= */
async function onRegister(e) {
  e.preventDefault();
  if (S.busy) return;
  showErr('reg-error-s2', '');
  if (S.enrollSamples.length < 3) {
    showErr('reg-error-s2', '请先完成 3 个姿态的人脸样本采集');
    return;
  }
  S.busy = true;
  const btn = $('reg-submit');
  btn.dataset.label = '完成注册';
  setBusy(btn, true, '正在注册…');
  try {
    const res = await api.register({
      username: val('reg-username'),
      password: $('reg-password').value,
      displayName: val('reg-display'),
      faceSamples: S.enrollSamples,
      liveness: S.enrollLiveness,   // 注册时同样要求活体通过
    });
    if (!res.ok) {
      showErr('reg-error-s2', res.message);
      return;
    }
    const uname = val('reg-username');
    resetRegisterToStep(1);
    $('form-register').reset();
    updateStrength('');
    switchAuthTab('login');
    $('login-username').value = uname;
    $('login-password').value = '';
    toast(`注册成功!请使用账号 ${uname} 登录`, 'success');
    reportSecurity(buildSecEvent({
      username: uname,
      wiz: { liveness: S.enrollLiveness || null, spoof: S.enrollSpoof || null },
      decision: 'allow', type: 'enroll_pass',
      extra: { detail: { sampleCount: S.enrollSamples.length } },
    }));
  } finally {
    S.busy = false;
    setBusy(btn, false, '');
  }
}

/* 人脸录入向导(注册第 2 步) */
async function openEnroll() {
  if (S.busy) return;
  showErr('reg-error-s2', '');
  const btn = $('btn-open-enroll');
  btn.disabled = true;
  try {
    const wiz = await openCameraWizard({ mode: 'enroll' });
    if (!wiz.ok) {
      if (wiz.reason === 'cancelled') return;
      if (wiz.reason === 'liveness') {
        reportSecurity(buildSecEvent({
          username: val('reg-username') || '-', wiz, decision: 'reject', type: 'enroll_liveness_fail',
        }));
      }
      if (wiz.reason === 'spoof') {
        reportSecurity(buildSecEvent({
          username: val('reg-username') || '-', wiz, decision: 'reject', type: 'enroll_spoof_reject',
        }));
        const sm = '未通过活体防伪检测(疑似屏幕重放/照片/贴纸遮挡),本次录入被拒绝';
        showErr('reg-error-s2', sm);
        toast(sm, 'error');
        return;
      }
      let msg = '人脸采集失败:摄像头不可用或人脸模型加载失败';
      if (wiz.reason === 'liveness') {
        const lf = wiz.liveness && wiz.liveness.failReason;
        msg = lf === 'timeout'
          ? '活体动作超时:请按提示 眨眼/张嘴/摇头,并保持面部在框内后重试'
          : lf === 'no-face'
            ? '采集期间未持续检测到人脸:请正对摄像头、调整距离与光线后重试'
            : '活体挑战未通过(疑似静态照片/视频),本次录入被拒绝';
      }
      showErr('reg-error-s2', msg);
      toast(msg, 'error');
      return;
    }
    S.enrollSamples = wiz.samples.slice();
    S.enrollLiveness = wiz.liveness || null;
    S.enrollSpoof = wiz.spoof || null;
    renderThumbs(S.enrollSamples);
    $('reg-submit').disabled = false;
    $('reg-face-hint').textContent = '已通过活体挑战并采集 3 个姿态样本。如质量不佳可再次点击按钮重新采集。';
  } finally {
    btn.disabled = false;
  }
}

/* ================= 初始化 ================= */
function bindEvents() {
  // 页签
  document.querySelectorAll('[data-auth-tab]').forEach((b) => {
    b.addEventListener('click', () => switchAuthTab(b.dataset.authTab));
  });
  document.querySelectorAll('[data-switch-to]').forEach((b) => {
    b.addEventListener('click', () => switchAuthTab(b.dataset.switchTo));
  });

  // 表单提交
  $('form-login').addEventListener('submit', onLogin);
  $('form-register').addEventListener('submit', onRegister);

  // 注册步骤
  $('reg-next').addEventListener('click', () => {
    showErr('reg-error-s1', '');
    if (!validateRegStep1()) {
      showErr('reg-error-s1', '请按提示填写正确的账号信息');
      return;
    }
    gotoRegStep(2);
  });
  $('reg-back').addEventListener('click', () => { showErr('reg-error-s2', ''); gotoRegStep(1); });
  $('btn-open-enroll').addEventListener('click', openEnroll);

  // 密码强度
  $('reg-password').addEventListener('input', (e) => updateStrength(e.target.value));

  // 显示/隐藏密码
  document.querySelectorAll('[data-eye]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inp = $(btn.dataset.eye);
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
    });
  });

  // 演示账号快速填充
  $('btn-fill-demo').addEventListener('click', () => {
    $('login-username').value = CFG.DEMO.username;
    $('login-password').value = CFG.DEMO.password;
    toast('已填入演示账号(demo / Demo@1234)', 'info');
  });

  // 退出登录
  $('btn-logout').addEventListener('click', () => {
    store.clearSession();
    showAuth();
    switchAuthTab('login');
    $('form-login').reset();
    toast('已退出登录', 'info');
  });
}

async function init() {
  await api.initMode();           // auto:探测网关 /api/v1/health 是否在线
  await store.seedDemo();
  // 模式徽标(元素可能已从页面移除,判空跳过,不影响其余逻辑)
  const badge = $('mode-badge');
  if (badge) {
    if (!api.isSimulated()) {
      badge.textContent = '已连接后端 · ' + (CFG.API_MODE === 'auto' ? '网关在线' : CFG.API_BASE);
    } else {
      badge.textContent = CFG.API_MODE === 'mock' ? '前端演示 · 关键点活体已启用 · 比对模拟'
        : '未检测到后端 · 回退前端演示';
    }
  }
  renderThumbs([]);
  updateStrength('');
  bindEvents();
}

init();
