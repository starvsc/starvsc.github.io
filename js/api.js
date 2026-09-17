/**
 * API 门面层
 *
 * 模式:
 *   - mock  本地模拟 + 延时(纯前端演示,不依赖后端)
 *   - http  走网关 REST(/api/v1/*,契约见 config.js)
 *   - auto  启动时探测 CFG.API_BASE + '/health':网关在线→http,否则回退 mock。
 *           (前端若由网关托管,则同源相对路径 /api/v1 即可)
 *
 * 用法:应用入口先 `await api.initApiMode()`,随后 api.* 即按解析后的模式工作。
 */
import { CFG, SIMULATED_FACE_VERIFY } from './config.js';
import * as store from './store.js';

let httpOn = CFG.API_MODE === 'http';
let _simulated = CFG.API_MODE !== 'http' && SIMULATED_FACE_VERIFY;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  return Promise.resolve({ ok: false, code: 1, message });
}

function ok(data) {
  return { ok: true, code: 0, data };
}

/* ---------------- mock 实现 ---------------- */

async function mockRegister({ username, password, displayName, faceSamples }) {
  await delay(650);
  const name = (username || '').trim();
  if (name.length < 4 || name.length > 20) return fail('账号长度需为 4-20 位');
  if (!/^[A-Za-z0-9_]+$/.test(name)) return fail('账号仅允许字母、数字、下划线');
  if (!password || password.length < 8) return fail('密码长度至少 8 位');
  if (store.findUser(name)) return fail('该账号已存在,请直接登录');
  if (!faceSamples || faceSamples.length < 3) return fail('人脸样本不完整,请重新采集');
  const rec = await store.addUser({ username: name, password, displayName, faceSamples });
  return ok({ username: rec.username, displayName: rec.displayName, sampleCount: rec.sampleCount });
}

async function mockLogin({ username, password }) {
  await delay(500);
  const rec = store.findUser(username);
  if (!rec) return fail('账号不存在');
  const pass = await store.verifyPassword(rec, password);
  if (!pass) return fail('账号或密码错误');
  return ok({ username: rec.username, displayName: rec.displayName, faceRegistered: rec.sampleCount > 0 });
}

async function mockFaceEnroll({ username, samples }) {
  await delay(400);
  const rec = store.findUser(username);
  if (!rec) return fail('账号不存在,无法保存人脸模板');
  rec.faceSamples = samples.slice();
  rec.sampleCount = samples.length;
  return ok({ templateId: rec.id + '_' + Date.now().toString(36), sampleCount: samples.length });
}

async function mockFaceVerify({ username }) {
  await delay(1200);
  const rec = store.findUser(username);
  if (!rec) return fail('账号不存在');
  return ok({
    passed: SIMULATED_FACE_VERIFY,
    score: SIMULATED_FACE_VERIFY ? 0.968 + Math.random() * 0.02 : 0,
    spoof: false,
    simulated: SIMULATED_FACE_VERIFY,
    elapsedMs: 1100,
  });
}

async function mockFaceCompare() {
  await delay(300);
  // 双图比对依赖后端(队友 faceauth_compare2),mock 模式下不模拟“是否同人”,避免误导
  return fail('双图比对需要后端服务(队友 C++ faceauth_compare2)。请启动网关后再试。');
}

/* ---------------- http 实现 ---------------- */

async function httpRequest(path, body) {
  const res = await fetch(CFG.API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ code: -1, message: '后端返回格式异常' }));
  if (json.code === 0) return ok(json.data || {});
  return { ok: false, code: json.code, message: json.message || '请求失败' };
}

function netErr() {
  return fail('网络错误,请确认网关/后端服务已启动');
}

async function httpRegister(payload) {
  try { return await httpRequest(CFG.ENDPOINTS.register, payload); } catch (e) { return netErr(); }
}
async function httpLogin(payload) {
  try { return await httpRequest(CFG.ENDPOINTS.login, payload); } catch (e) { return netErr(); }
}
async function httpFaceEnroll(payload) {
  try { return await httpRequest(CFG.ENDPOINTS.faceEnroll, payload); } catch (e) { return netErr(); }
}
async function httpFaceVerify(payload) {
  try { return await httpRequest(CFG.ENDPOINTS.faceVerify, payload); } catch (e) { return netErr(); }
}
async function httpFaceCompare(payload) {
  try { return await httpRequest(CFG.ENDPOINTS.compare, payload); } catch (e) { return netErr(); }
}

/* ---------------- 安全事件(告警,需求7) ---------------- */
const SEC_KEY = 'rfau.security.v1';

async function httpAdminRegister(payload) {
  try { return await httpRequest(CFG.ENDPOINTS.adminRegister, payload); } catch (e) { return netErr(); }
}
async function httpAdminLogin(payload) {
  try { return await httpRequest(CFG.ENDPOINTS.adminLogin, payload); } catch (e) { return netErr(); }
}
async function httpAdminUsers() {
  let token = '';
  try { token = (JSON.parse(localStorage.getItem('rfau.admin.session') || '{}').token) || ''; } catch (e) { /* ignore */ }
  const h = token ? { 'X-Admin-Token': token } : undefined;
  try { return await httpJson('GET', CFG.ENDPOINTS.adminUsers, null, h); } catch (e) { return netErr(); }
}

async function httpJson(method, path, body, extraHeaders) {
  const res = await fetch(CFG.API_BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ code: -1, message: '后端返回格式异常' }));
  if (json.code === 0) return ok(json.data || {});
  return { ok: false, code: json.code, message: json.message || '请求失败' };
}

function secLocalPush(evt) {
  try {
    const arr = JSON.parse(localStorage.getItem(SEC_KEY) || '[]');
    arr.push(Object.assign({ id: 'local_' + Date.now(), created_at: new Date().toISOString() }, evt));
    while (arr.length > 500) arr.shift();
    localStorage.setItem(SEC_KEY, JSON.stringify(arr));
  } catch (e) { /* ignore */ }
}

function secLocalList() {
  try { return JSON.parse(localStorage.getItem(SEC_KEY) || '[]').slice().reverse(); }
  catch (e) { return []; }
}

async function httpSecurityReport(evt) {
  try { return await httpJson('POST', CFG.ENDPOINTS.securityEvents, evt); } catch (e) { return netErr(); }
}
async function httpSecurityList() {
  try { return await httpJson('GET', CFG.ENDPOINTS.securityEvents); } catch (e) { return netErr(); }
}
async function httpSecurityExport() {
  try { return await httpJson('GET', CFG.ENDPOINTS.securityExport); } catch (e) { return netErr(); }
}

async function mockSecurityReport(evt) { secLocalPush(evt); return ok({ local: true }); }
async function mockSecurityList() { const e = secLocalList(); return ok({ count: e.length, events: e }); }
async function mockSecurityExport() { const e = secLocalList(); return ok({ count: e.length, events: e }); }


/* ---------------- 模式探测 ---------------- */

async function detectHttp() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(CFG.API_BASE + '/health', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) return false;
    const j = await res.json().catch(() => ({ code: -1 }));
    return !!(j && j.code === 0);
  } catch (e) {
    return false;
  }
}

/** 应用启动时调用:解析最终模式(auto 模式下探测网关) */
export async function initApiMode() {
  if (CFG.API_MODE === 'http') {
    httpOn = true; _simulated = false;
  } else if (CFG.API_MODE === 'mock') {
    httpOn = false; _simulated = SIMULATED_FACE_VERIFY;
  } else {
    httpOn = await detectHttp();
    _simulated = !httpOn && SIMULATED_FACE_VERIFY;
  }
}

export function isHttpMode() { return httpOn; }
export function isSimulatedMode() { return _simulated; }

/* ---------------- 统一导出 ---------------- */

export const api = {
  register: (p) => (httpOn ? httpRegister(p) : mockRegister(p)),
  login: (p) => (httpOn ? httpLogin(p) : mockLogin(p)),
  faceEnroll: (p) => (httpOn ? httpFaceEnroll(p) : mockFaceEnroll(p)),
  faceVerify: (p) => (httpOn ? httpFaceVerify(p) : mockFaceVerify(p)),
  adminRegister: (p) => (httpOn ? httpAdminRegister(p) : fail('管理端需要后端服务,请启动网关后再试')),
  adminLogin: (p) => (httpOn ? httpAdminLogin(p) : fail('管理端需要后端服务,请启动网关后再试')),
  adminUsers: () => (httpOn ? httpAdminUsers() : fail('管理端需要后端服务,请启动网关后再试')),
  compare: (p) => (httpOn ? httpFaceCompare(p) : mockFaceCompare(p)),
  securityReport: (evt) => (httpOn ? httpSecurityReport(evt) : mockSecurityReport(evt)),
  securityList: () => (httpOn ? httpSecurityList() : mockSecurityList()),
  securityExport: () => (httpOn ? httpSecurityExport() : mockSecurityExport()),
  isSimulated: () => _simulated,
  isHttp: isHttpMode,
  initMode: initApiMode,
};
