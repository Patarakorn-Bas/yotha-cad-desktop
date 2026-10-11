// settings.js — เก็บการตั้งค่าของโปรแกรม (โฟลเดอร์ส่งออก, ไฟล์ล่าสุด, ขนาดหน้าต่าง)
// ไฟล์อยู่ที่ %APPDATA%\YothaCAD\settings.json
'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_RECENT = 12;
let cache = null;
let saveTimer = null;
const recentListeners = [];

function file() { return path.join(app.getPath('userData'), 'settings.json'); }

function get() {
  if (!cache) {
    try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { cache = {}; }
    if (!Array.isArray(cache.recent)) cache.recent = [];
    if (cache.exportAsk === undefined) cache.exportAsk = true;
  }
  return cache;
}

function set(patch) {
  Object.assign(get(), patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}

function flush() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  } catch (_) { /* ไม่ร้ายแรง */ }
}

function norm(p) { return process.platform === 'win32' ? p.toLowerCase() : p; }

function addRecent(p) {
  const r = get().recent;
  if (r[0] && norm(r[0]) === norm(p)) return;          // อยู่บนสุดแล้ว
  const next = [p, ...r.filter((x) => norm(x) !== norm(p))].slice(0, MAX_RECENT);
  set({ recent: next });
  recentListeners.forEach((fn) => fn(p));
}

function removeRecent(p) {
  set({ recent: get().recent.filter((x) => norm(x) !== norm(p)) });
}

function onRecent(fn) { recentListeners.push(fn); }

app.on('will-quit', flush);

module.exports = { get, set, addRecent, removeRecent, onRecent };
