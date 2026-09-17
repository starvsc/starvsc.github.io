/**
 * 动作活体挑战引擎(liveness.js)
 *
 * 用途:人脸认证/注册前,要求用户在摄像头前完成一组随机动作
 * (眨眼 / 张嘴 / 摇头 / 点头),由 68 关键点几何指标实时判定。
 * 静态照片无法做出动作、预录视频难以匹配随机指令序列,由此构成
 * “防照片 / 防视频重放”的第一层活体防线(需求 4、5)。
 *
 * 生产建议:前端动作活体仅是第一层;后端应叠加 纹理/光流/屏闪反射/
 * 深度(或红外)等多模态活体,以及 3D 头部姿态(需求 6)。
 *
 * 使用方式:
 *   const ch = createLiveness({ mode:'enroll'|'verify' });
 *   // 每得到一个关键点检测结果就:
 *   ch.tick(detectResult);           // detectResult 来自 face-engine.detectMetrics
 *   // 轮询:
 *   ch.state  => 'running'|'pass'|'fail'
 *   ch.current  => 当前动作
 *   // 结束时:
 *   ch.summary() => 结构化结果(可附带给后端做审计/告警)
 */
import { CFG } from './config.js';

const L = CFG.LIVENESS;

/** 动作展示文案 */
export function labelOf(key) {
  return (L.labels && L.labels[key]) || { blink: '请眨一下眼睛', open_mouth: '请张开嘴巴', shake_head: '请左右摇头', nod: '请点一下头' }[key] || key;
}

/** 生成一组动作序列(可随机排序) */
export function buildActions(mode) {
  const pool = (L.actions && L.actions[mode]) || ['shake_head', 'nod', 'open_mouth'];
  let actions = [...pool];
  if (L.randomize) {
    for (let i = actions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [actions[i], actions[j]] = [actions[j], actions[i]];
    }
  }
  const count = (L.pickCount && L.pickCount[mode]) || actions.length;
  actions = actions.slice(0, Math.max(1, Math.min(count, actions.length)));
  return actions.map((key, i) => ({ key, label: labelOf(key), index: i }));
}

function randomId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return 'lvc_' + [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 创建一个活体挑战会话。
 * @param {{ mode?:'enroll'|'verify', actions?:Array<{key,label}>, onEvent?:Function }} opts
 */
export function createLiveness({ mode = 'verify', actions, onEvent } = {}) {
  const act = actions && actions.length ? actions : buildActions(mode);
  const cfg = {
    perAction: L.perActionTimeoutMs,
    noFaceGrace: L.noFaceGraceMs,
    marOpen: L.mouthOpenMar,
    turn: L.turnAbs,
    nod: L.nodAbs,
    // 眨眼自适应
    eyeHistoryMs: L.eyeHistoryMs,
    eyeBaseFloor: L.eyeBaseFloor,
    eyeBaseCap: L.eyeBaseCap,
    eyeClosedFactor: L.eyeClosedFactor,
    eyeClosedOffset: L.eyeClosedOffset,
    eyeClosedFloor: L.eyeClosedFloor,
    eyeOpenRecover: L.eyeOpenRecover,
    minClosed: L.blinkMinClosedMs,
    maxClosed: L.blinkMaxClosedMs,
    motion: L.motionGate || { enabled: false },
    armMs: (L.motionGate && L.motionGate.armMs) || 0,
    absCap: (L.perActionTimeoutMs) * ((L.motionGate && L.motionGate.absoluteCapFactor) || 3),
  };

  const sess = {
    challengeId: randomId(),
    mode,
    actions: act,
    state: 'running',        // running | pass | fail
    current: act[0] || null,
    currentIndex: 0,
    records: [],             // 已完成动作记录
    startedAt: performance.now(),
    failReason: null,
    // 检测子状态
    eyePhase: 'open',        // open | closed(自适应眨眼)
    eyeClosedAt: 0,
    earHist: [],             // {t,ear} 用于估计个人睁眼基线
    mouthHold: 0,
    yawBuf: [],              // {t,v}
    pitchBuf: [],
    noFaceSince: 0,
    // 静止门控
    faceLast: null,      // 上一有效帧人脸中心/脸宽 {cx,cy,bw,t}
    movingSince: 0,      // 连续判定为“晃动”的起始时间
    pausedMs: 0,         // 因晃动累计暂停的时长(超时扣除)
    actStart: 0,         // 当前动作有效起始时间(创建/换动作时置为 now)
    armed: false,
    staticSince: 0,
    lastStatus: null,    // 'moving' | 'no-face' | null
    emit: onEvent || (() => {}),
  };

  /* ---------------- 辅助 ---------------- */

  function pushBuf(buf, t, v, windowMs) {
    buf.push({ t, v });
    const cutoff = t - windowMs;
    while (buf.length && buf[0].t < cutoff) buf.shift();
  }

  function range(buf) {
    if (!buf.length) return { min: 0, max: 0 };
    let mn = Infinity, mx = -Infinity;
    for (const e of buf) { if (e.v < mn) mn = e.v; if (e.v > mx) mx = e.v; }
    return { min: mn, max: mx };
  }

  function advance() {
    if (sess.currentIndex + 1 < act.length) {
      sess.currentIndex += 1;
      sess.current = act[sess.currentIndex];
      resetSub();
      sess.emit('instruction', sess.current);
    } else {
      sess.state = 'pass';
      sess.emit('pass', sess.summary());
    }
  }

  function fail(reason) {
    if (sess.state !== 'running') return;
    sess.state = 'fail';
    sess.failReason = reason;
    sess.records.push({ key: sess.current.key, label: sess.current.label, ok: false, reason });
    sess.emit('fail', sess.summary());
  }

  function resetSub() {
    sess.eyePhase = 'open';
    sess.eyeClosedAt = 0;
    sess.earHist = [];
    sess.mouthHold = 0;
    sess.yawBuf = [];
    sess.pitchBuf = [];
    sess.noFaceSince = 0;
    sess.faceLast = null;
    sess.movingSince = 0;
    sess.pausedMs = 0;
    sess.actStart = performance.now();
    sess.lastStatus = null;
    sess.armed = false;
    sess.staticSince = 0;
  }

  /* ---------------- 动作事件判定 ---------------- */

  // —— 眨眼:自适应个人睁眼基线 + 单帧闭眼即捕获 ——
  function eyeBaseline(now) {
    const win = now - cfg.eyeHistoryMs;
    const vals = [];
    for (let i = sess.earHist.length - 1; i >= 0; i--) {
      if (sess.earHist[i].t < win) break;
      vals.push(sess.earHist[i].ear);
    }
    if (!vals.length) return cfg.eyeBaseCap; // 样本不足时用较严基线,避免误报
    vals.sort((a, b) => a - b);
    const v = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.8))];
    return Math.min(cfg.eyeBaseCap, Math.max(cfg.eyeBaseFloor, v));
  }

  function eyeClosedThr(base) {
    return Math.max(cfg.eyeClosedFloor, Math.min(base * cfg.eyeClosedFactor, base - cfg.eyeClosedOffset));
  }

  function eyeOpenThr(base) {
    return Math.max(cfg.eyeClosedFloor + 0.02, base * cfg.eyeOpenRecover);
  }

  function tickBlink(m, now) {
    sess.earHist.push({ t: now, ear: m.ear });
    const cutoff = now - cfg.eyeHistoryMs;
    while (sess.earHist.length && sess.earHist[0].t < cutoff) sess.earHist.shift();

    const base = eyeBaseline(now);
    const cThr = eyeClosedThr(base);
    const oThr = eyeOpenThr(base);

    if (sess.eyePhase === 'open') {
      if (m.ear < cThr) {
        sess.eyePhase = 'closed';
        sess.eyeClosedAt = now;
      }
      return false;
    }
    // closed 状态
    const dur = now - sess.eyeClosedAt;
    if (m.ear > oThr) {
      // 重新睁开 → 一次眨眼完成
      sess.eyePhase = 'open';
      return dur >= cfg.minClosed && dur <= cfg.maxClosed;
    }
    if (dur > cfg.maxClosed) {
      // 闭眼过久(如眯眼/眨眼很慢),重新等下一次
      sess.eyePhase = 'open';
      sess.eyeClosedAt = 0;
    }
    return false;
  }

  function tickMouth(m) {
    if (m.mar > cfg.marOpen) {
      sess.mouthHold += 1;
      if (sess.mouthHold >= 2) { sess.mouthHold = 0; return true; }
    } else {
      sess.mouthHold = 0;
    }
    return false;
  }

  function tickShake(m, now) {
    pushBuf(sess.yawBuf, now, m.yaw, 1600);
    const { min, max } = range(sess.yawBuf);
    return max > cfg.turn && min < -cfg.turn;
  }

  function tickNod(m, now) {
    pushBuf(sess.pitchBuf, now, m.pitch, 1600);
    const { min, max } = range(sess.pitchBuf);
    return max - min > cfg.nod * 1.5;
  }

  /* ---------------- 静止门控 ---------------- */

  /** 估算相邻有效帧间“人脸整体晃动”:中心位移或尺度变化是否明显 */
  function evaluateMotion(m, now) {
    const box = m.box;
    const bw = box.width || 1;
    const cx = box.x + bw / 2;
    const cy = box.y + box.height / 2;
    const last = sess.faceLast;
    sess.faceLast = { cx, cy, bw, t: now };
    if (!last || now - last.t > cfg.motion.maxDtMs) return false; // 缺少对比帧时不误判
    const dx = (cx - last.cx) / bw;
    const dy = (cy - last.cy) / bw;
    const ds = Math.abs(bw - last.bw) / bw;
    return (
      Math.hypot(dx, dy) > (cfg.motion.moveRatio || 0.08) ||
      ds > (cfg.motion.scaleRatio || 0.15)
    );
  }

  /** 晃动期间清掉可能残留的半次眨眼/张嘴状态,防止晃动结束时误触发 */
  function resetGatedPartial() {
    sess.eyePhase = 'open';
    sess.eyeClosedAt = 0;
    sess.earHist = [];
    sess.mouthHold = 0;
  }

  /** 人脸歪头(倾斜角 roll)过大时也视为“不适合眨眼/张嘴”,需先回正 */
  function isTilted(m) {
    const deg = cfg.motion.rollAbsDeg;
    return !!deg && Math.abs(m.roll || 0) > deg;
  }

  /* ---------------- 对外 tick ---------------- */

  /**
   * @param {object} m face-engine.detectMetrics 的返回
   * @param {number} [now] performance.now() 时间戳
   * @returns {object} 会话快照 {state,current,index,total,records}
   */
  function tick(m, now) {
    now = now || performance.now();
    if (sess.state !== 'running') return snapshot();
    if (!sess.current) { sess.state = 'pass'; return snapshot(); }

    if (!m || !m.ok) {
      if (m && (m.reason === 'no-face' || m.reason === 'too-small')) {
        // 脸离开画面:清空运动对比状态,避免回来后误累计暂停
        sess.faceLast = null;
        sess.movingSince = 0;
        if (!sess.noFaceSince) sess.noFaceSince = now;
        else if (now - sess.noFaceSince > cfg.noFaceGrace) {
          fail('no-face');
          return snapshot();
        }
        sess.lastStatus = 'no-face';
        sess.emit('status', 'no-face');
      }
      return snapshot();
    }
    sess.noFaceSince = 0;

    // —— 静止门控:眨眼/张嘴前,人脸晃动明显或歪头(倾斜)过大则自动暂停判定 ——
    // —— 指令后应答约束:先静止 armMs 才开始计数(防连续播放/循环视频)——
    if (cfg.armMs > 0 && !sess.armed) {
      const anyMove = evaluateMotion(m, now);
      if (anyMove) {
        sess.staticSince = 0;
        sess.lastStatus = 'moving';
        sess.emit('status', 'moving');
        return snapshot();
      }
      if (!sess.staticSince) sess.staticSince = now;
      if (now - sess.staticSince >= cfg.armMs) {
        sess.armed = true;
        sess.actStart = now;
        sess.pausedMs = 0;
        sess.yawBuf = [];
        sess.pitchBuf = [];
        sess.mouthHold = 0;
      } else {
        return snapshot();
      }
    }
    const motion = cfg.motion;
    const gated = motion.enabled && (motion.applyTo || []).includes(sess.current.key);
    const moving = gated ? (evaluateMotion(m, now) || isTilted(m)) : false;

    if (moving) {
      if (!sess.movingSince) sess.movingSince = now;
      sess.lastStatus = 'moving';
      resetGatedPartial();               // 清掉残留的半次眨眼/张嘴状态
      sess.emit('status', 'moving');
      return snapshot();                 // 暂停:不累计超时、不误触发
    }
    if (sess.movingSince) {              // 重新静止:结算暂停时长
      sess.pausedMs += now - sess.movingSince;
      sess.movingSince = 0;
    }
    sess.lastStatus = null;

    // 超时判定:扣除晃动导致的暂停;另有绝对上限防止无限暂停
    const effStart = sess.actStart + sess.pausedMs;
    if (now - effStart > cfg.perAction) { fail('timeout'); return snapshot(); }
    if (now - sess.actStart > cfg.absCap) { fail('timeout'); return snapshot(); }

    let done = false;
    switch (sess.current.key) {
      case 'blink': done = tickBlink(m, now); break;
      case 'open_mouth': done = tickMouth(m); break;
      case 'shake_head': done = tickShake(m, now); break;
      case 'nod': done = tickNod(m, now); break;
      default: done = true; // 未知动作视为完成,避免卡死
    }

    if (done) {
      const ms = Math.round(now - (sess.actStart + sess.pausedMs));
      sess.records.push({ key: sess.current.key, label: sess.current.label, ok: true, ms });
      sess.actStart = now;
      sess.pausedMs = 0;
      sess.movingSince = 0;
      sess.faceLast = null;
      sess.lastStatus = null;
      sess.emit('done-action', sess.records[sess.records.length - 1]);
      advance();
    }
    return snapshot();
  }

  /** 完整执行下一个动作(advance)的干净重置 */
  function snapshot() {
    return {
      state: sess.state,
      challengeId: sess.challengeId,
      current: sess.current,
      currentIndex: sess.currentIndex,
      total: act.length,
      done: sess.records.filter((r) => r.ok).length,
      records: sess.records.slice(),
      failReason: sess.failReason,
      status: sess.lastStatus,     // 'moving' | 'no-face' | null
    };
  }

  /** 结构化结果(供后端审计 / 告警,需求 7) */
  function summary() {
    return {
      challengeId: sess.challengeId,
      mode: sess.mode,
      passed: sess.state === 'pass',
      actions: sess.records.slice(),
      failReason: sess.failReason,
      durationMs: Math.round(performance.now() - sess.startedAt),
    };
  }

  resetSub();                    // 内部已设置 actStart/pausedMs/movingSince 等
  sess.emit('instruction', sess.current);
  return { tick, snapshot, summary, get state() { return sess.state; }, get current() { return sess.current; }, get challengeId() { return sess.challengeId; } };
}
