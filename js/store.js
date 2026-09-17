/**
 * Mock 用户库(localStorage)
 *
 * 仅用于“前端独立演示”。正式接入后端后,此模块将不再被 api.js 调用。
 * 注意:浏览器端仅做演示级散列;生产环境密码应使用后端 SM3/BCrypt+盐 存储,
 *       人脸特征模板也应存于服务端,勿以明文 dataURL 形式长期保存。
 */
import { CFG } from './config.js';

const USERS_KEY = 'rfau.users.v1';
const SESSION_KEY = 'rfau.session.v1';

function loadUsers() {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveUsers(list) {
  localStorage.setItem(USERS_KEY, JSON.stringify(list));
}

export function findUser(username) {
  const u = (username || '').trim().toLowerCase();
  return loadUsers().find((x) => x.username === u) || null;
}

export function addUser({ username, password, displayName, faceSamples }) {
  const list = loadUsers();
  const salt = randomHex(16);
  const rec = {
    id: 'u_' + Date.now().toString(36) + '_' + randomHex(4),
    username: username.trim().toLowerCase(),
    displayName: (displayName || username.trim()).trim(),
    passwordHash: null, // 异步填充
    salt,
    faceSamples: Array.isArray(faceSamples) ? faceSamples.slice(0, 6) : [],
    sampleCount: (faceSamples || []).length,
    createdAt: new Date().toISOString(),
  };
  list.push(rec);
  saveUsers(list);
  return hashPassword(password, salt).then((h) => {
    rec.passwordHash = h;
    saveUsers(list);
    return rec;
  });
}

export function verifyPassword(rec, password) {
  return hashPassword(password || '', rec.salt).then((h) => {
    // 演示级:恒定时间比较
    return constantTimeEquals(h, rec.passwordHash);
  });
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(user) {
  const s = { username: user.username, displayName: user.displayName, loginAt: new Date().toISOString() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/** 写入演示账号(若不存在) */
export async function seedDemo() {
  if (!findUser(CFG.DEMO.username)) {
    await addUser({
      username: CFG.DEMO.username,
      password: CFG.DEMO.password,
      displayName: CFG.DEMO.displayName,
      faceSamples: [],
    });
  }
}

/* ---------- 密码散列(演示用) ---------- */

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password, saltHex) {
  if (crypto && crypto.subtle) {
    const data = new TextEncoder().encode(saltHex + ':' + password);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 降级:非安全上下文时使用非密码学散列(仅供演示,勿用于生产)
  return fallbackHash(saltHex + ':' + password);
}

function fallbackHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
