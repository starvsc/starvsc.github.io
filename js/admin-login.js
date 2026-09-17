/**
 * 管理端登录/注册页(admin-login.js)
 * 仅需账号 + 密码(无人脸)。登录/注册成功后写入 session 并跳转到 admin.html 主界面。
 */
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'rfau.admin.session';

function showErr(id, msg) { $(id).textContent = msg || ''; }
function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }

document.querySelectorAll('[data-al-tab]').forEach((b) => {
  b.addEventListener('click', () => {
    const t = b.dataset.alTab;
    document.querySelectorAll('[data-al-tab]').forEach((x) => x.classList.toggle('active', x === b));
    $('al-form-login').hidden = t !== 'login';
    $('al-form-register').hidden = t !== 'register';
    showErr('al-login-error', '');
    showErr('al-reg-error', '');
  });
});

function enter(acc) {
  saveSession(acc);
  location.href = 'admin.html';
}

$('al-form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  showErr('al-login-error', '');
  const username = $('al-login-username').value.trim();
  const password = $('al-login-password').value;
  if (!username || !password) { showErr('al-login-error', '请输入账号和密码'); return; }
  const res = await api.adminLogin({ username, password });
  if (!res.ok) { showErr('al-login-error', res.message); return; }
  enter(res.data);
});

$('al-form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  showErr('al-reg-error', '');
  const username = $('al-reg-username').value.trim();
  const password = $('al-reg-password').value;
  if (!username || !password) { showErr('al-reg-error', '请输入账号和密码'); return; }
  const keyEl = document.getElementById('al-reg-key');
  const res = await api.adminRegister({ username, password, key: keyEl ? keyEl.value.trim() : '' });
  if (!res.ok) { showErr('al-reg-error', res.message); return; }
  enter(res.data);
});

(async () => { await api.initMode(); })();
