/**
 * 管理端主界面(admin.js)
 * 展示用户端注册的用户信息列表。未登录则跳转到 admin-login.html。
 */
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'rfau.admin.session';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }

async function renderUsers() {
  const res = await api.adminUsers();
  if (!res.ok) {
    $('ad-user-rows').innerHTML = '';
    $('ad-count').textContent = '加载失败：' + res.message;
    return;
  }
  const users = res.data.users || [];
  $('ad-user-rows').innerHTML = users.map((u) => {
    const face = u.faceCount > 0
      ? `<span class="badge-mini ok">${u.faceCount} 张</span>`
      : '<span class="badge-mini">未录入</span>';
    return `<tr><td>${esc(u.username)}</td><td>${esc(u.displayName || '-')}</td>` +
      `<td>${face}</td><td>${esc(u.createdAt || '-')}</td></tr>`;
  }).join('');
  $('ad-count').textContent = `共 ${users.length} 个用户`;
}

function logout() {
  clearSession();
  location.href = 'admin-login.html';
}

$('ad-refresh').addEventListener('click', renderUsers);
$('ad-logout').addEventListener('click', logout);

(async () => {
  await api.initMode();
  const s = loadSession();
  if (!s || !s.username) { location.href = 'admin-login.html'; return; }
  $('ad-who').textContent = '管理员：' + (s.displayName || s.username);
  renderUsers();
})();
