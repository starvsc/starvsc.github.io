/**
 * 安全告警中心(security.js)
 * 从网关拉取 security_events(离线自动回退 localStorage),统计+列表+导出 JSON。
 */
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const els = {
  mode: $('sec-mode'),
  cards: $('sec-cards'),
  body: $('sec-body'),
  refresh: $('btn-refresh'),
  exportBtn: $('btn-export'),
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function hintText(ev) {
  const d = ev.detail || {};
  const arr = d.spoofHints || (d.spoof && d.spoof.hints) || [];
  if (!Array.isArray(arr) || !arr.length) return '-';
  return arr.map((h) => `${h.type}${h.suspicious ? '!' : ''}`).join(' · ');
}

function detailText(ev) {
  const d = ev.detail || {};
  const lv = d.liveness || {};
  const parts = [];
  if (lv.actions && Array.isArray(lv.actions)) {
    parts.push('actions:' + lv.actions.map((a) => a.key + (a.ok ? '✓' : '✗')).join(','));
  }
  if (lv.failReason) parts.push('fail:' + lv.failReason);
  if (d.reason) parts.push('reason:' + d.reason);
  if (parts.length) return parts.join('; ');
  return JSON.stringify(d).slice(0, 160);
}

function pillClass(ev) {
  const t = ev.event_type, dd = ev.decision;
  if (t === 'spoof_suspect' || t === 'liveness_fail') return 'spoof_suspect';
  if (dd === 'reject') return 'reject';
  if (dd === 'allow') return 'allow';
  return 'watch';
}

function render(events) {
  els.body.innerHTML = '';
  if (!events.length) {
    els.body.innerHTML = '<tr><td colspan="8" class="empty">暂无安全事件。去跑一次登录/注册活体,即可看到记录。</td></tr>';
    return;
  }
  const byType = {};
  events.forEach((e) => { byType[e.event_type] = (byType[e.event_type] || 0) + 1; });
  const rejectCount = events.filter((e) => e.decision === 'reject').length;
  const spoofCount = events.filter((e) => e.event_type === 'spoof_suspect').length;

  const mk = (label, val, cls) => `<div class="card"><div class="k">${label}</div><div class="v ${cls || ''}">${val}</div></div>`;
  els.cards.innerHTML =
    mk('总事件', events.length) +
    mk('拒绝', rejectCount, 'danger') +
    mk('疑似攻击', spoofCount, 'warn') +
    mk('放行', events.filter((e) => e.decision === 'allow').length, 'ok');

  events.forEach((e) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc((e.created_at || '').replace('T', ' ').slice(0, 19))}</td>` +
      `<td><span class="pill ${pillClass(e)}">${esc(e.event_type)}</span></td>` +
      `<td>${esc(e.username)}</td>` +
      `<td>${esc(e.decision)}</td>` +
      `<td>${e.score != null ? Number(e.score).toFixed(3) : '-'}</td>` +
      `<td>${esc((e.challenge_id || '').slice(0, 14))}</td>` +
      `<td>${esc(hintText(e))}</td>` +
      `<td class="det">${esc(detailText(e))}</td>`;
    els.body.appendChild(tr);
  });
}

async function load() {
  const res = await api.securityList();
  if (!res.ok) {
    els.body.innerHTML = `<tr><td colspan="8" class="empty">拉取失败:${esc(res.message || '')}</td></tr>`;
    return;
  }
  render(res.data.events || []);
}

async function doExport() {
  els.exportBtn.disabled = true;
  els.exportBtn.querySelector('.spinner').hidden = false;
  try {
    const res = await api.securityExport();
    const events = (res.ok && res.data.events) ? res.data.events : [];
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), count: events.length, events }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'faceauth-security-events.json';
    a.click();
    URL.revokeObjectURL(a.href);
  } finally {
    els.exportBtn.disabled = false;
    els.exportBtn.querySelector('.spinner').hidden = true;
  }
}

async function init() {
  await api.initMode();
  if (api.isHttp()) {
    els.mode.classList.add('on');
    els.mode.querySelector('span').textContent = '已连接后端 · 数据在 MySQL security_events';
  } else {
    els.mode.querySelector('span').textContent = '未连接后端 · 显示本地 localStorage 记录';
  }
  els.refresh.addEventListener('click', () => load());
  els.exportBtn.addEventListener('click', () => doExport());
  await load();
}

init();
