// main.js — โปรแกรมหลักของโยธาแคดบน Windows (Electron)
// หน้าที่: สร้างหน้าต่าง, เมนู, เปิด/บันทึกไฟล์ .ycad, ส่งออกไฟล์, รายการไฟล์ล่าสุด, อัปเดตอัตโนมัติ
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const settings = require('./settings');
const updater = require('./updater');

const APP_NAME = 'โยธาแคด';
const APP_ID = 'com.pattarakorn.yothacad';
const APP_DIR = path.join(__dirname, '..', 'app');          // สร้างโดย scripts/prepare-web.js
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const PROJECT_EXT = '.ycad';
const START_URL = 'app://yothacad/index.html';

// ---------------------------------------------------------------- เริ่มต้น
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// เปิดได้ทีละโปรแกรม: ถ้าเปิดซ้ำ (เช่น ดับเบิลคลิกไฟล์ .ycad อีกไฟล์) ให้ส่งไฟล์ไปยังโปรแกรมที่เปิดอยู่
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

// ---------------------------------------------------------------- สถานะหน้าต่าง
/** @type {Map<number, {win: BrowserWindow, intent: object, filePath: string|null, dirty: boolean, title: string, name: string, forceClose: boolean, closing: boolean}>} */
const windows = new Map();
let quitting = false;

function stateOf(win) { return win && windows.get(win.id); }
function allStates() { return [...windows.values()]; }

function createWindow(intent = { type: 'new' }) {
  const s = settings.get();
  const b = s.bounds || { width: 1440, height: 900 };
  const opts = {
    width: b.width, height: b.height, minWidth: 960, minHeight: 600,
    title: APP_NAME, icon: ICON, show: false, backgroundColor: '#0f1a2a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    },
  };
  // หน้าต่างใหม่เยื้องจากหน้าต่างที่เปิดอยู่เล็กน้อย
  const last = BrowserWindow.getFocusedWindow() || allStates().slice(-1).map(x => x.win)[0];
  if (last && !last.isDestroyed()) {
    const [x, y] = last.getPosition();
    opts.x = x + 28; opts.y = y + 28;
  } else if (b.x !== undefined) { opts.x = b.x; opts.y = b.y; }

  const win = new BrowserWindow(opts);
  const st = { win, intent, filePath: null, dirty: false, title: APP_NAME, name: '', forceClose: false, closing: false };
  windows.set(win.id, st);

  win.once('ready-to-show', () => {
    if (!last && s.maximized) win.maximize();
    win.show();
  });

  // ลิงก์ภายนอก (เช่น Civil Toolkit) เปิดในเบราว์เซอร์ ไม่เปิดในโปรแกรม
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('render-process-gone', () => { st.dirty = false; });
  // ชื่อหน้าต่างควบคุมโดยโปรแกรม (ชื่อไฟล์ + สถานะ) ไม่ใช้ <title> ของหน้าเว็บ
  win.on('page-title-updated', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (!st.forceClose && st.dirty) {
      e.preventDefault();
      confirmClose(st);
      return;
    }
    if (windows.size === 1) {
      settings.set({ bounds: win.isMaximized() ? (settings.get().bounds) : win.getBounds(), maximized: win.isMaximized() });
    }
  });
  win.on('closed', () => {
    flushStorage();
    windows.delete(win.id);
    for (const [id, p] of pending) if (p.winId === win.id) { pending.delete(id); p.resolve({ ok: false }); }
    rebuildMenuSoon();
  });
  win.on('focus', rebuildMenuSoon);

  win.loadURL(START_URL);
  rebuildMenuSoon();
  return win;
}

// ---------------------------------------------------------------- ส่งคำสั่งถึงหน้าเว็บ
let reqId = 0;
const pending = new Map();
function send(win, cmd, payload = {}) {
  if (win && !win.isDestroyed()) win.webContents.send('ycad:cmd', { cmd, ...payload });
}
/** ส่งคำสั่งแล้วรอผล (เช่น บันทึกก่อนปิด) */
function request(win, cmd, payload = {}, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve) => {
    const id = ++reqId;
    const t = setTimeout(() => { pending.delete(id); resolve({ ok: false, timeout: true }); }, timeoutMs);
    pending.set(id, { winId: win.id, resolve: (r) => { clearTimeout(t); resolve(r); } });
    send(win, cmd, { ...payload, requestId: id });
  });
}
ipcMain.on('ycad:reply', (_e, { id, result }) => {
  const p = pending.get(id);
  if (p) { pending.delete(id); p.resolve(result || {}); }
});

// ---------------------------------------------------------------- ปิดหน้าต่าง: ถามบันทึก
async function confirmClose(st) {
  if (st.closing) return;
  st.closing = true;
  try {
    const name = st.filePath ? path.basename(st.filePath) : (st.name || 'โครงการ');
    const { response } = await dialog.showMessageBox(st.win, {
      type: 'warning', title: APP_NAME,
      message: `บันทึกการแก้ไขใน “${name}” ก่อนปิดหรือไม่?`,
      detail: st.filePath
        ? 'ถ้าไม่บันทึก การแก้ไขตั้งแต่บันทึกครั้งล่าสุดจะหายไป'
        : 'งานนี้ยังไม่เคยบันทึกเป็นไฟล์ .ycad — ถ้าไม่บันทึก งานยังเก็บอยู่ในเมนู “จัดการโครงการ” ของโปรแกรม',
      buttons: ['บันทึก', 'ไม่บันทึก', 'ยกเลิก'], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (response === 2) { quitting = false; updater.cancelPendingInstall(); return; }
    const r = await request(st.win, response === 0 ? 'save-for-close' : 'discard-for-close');
    if (response === 0 && !r.ok) { quitting = false; updater.cancelPendingInstall(); return; }
    st.forceClose = true;
    st.win.close();
    // ถ้ากำลังออกจากโปรแกรม ให้ไล่ปิดหน้าต่างที่เหลือต่อ
    if (quitting) setImmediate(() => { if (windows.size) app.quit(); });
  } finally {
    st.closing = false;
  }
}

// ---------------------------------------------------------------- เปิดไฟล์
function isProjectPath(p) { return /\.(ycad|json)$/i.test(p); }

function filesFromArgv(argv) {
  return argv.slice(1).filter(a => !a.startsWith('-') && isProjectPath(a) && fs.existsSync(a)).map(a => path.resolve(a));
}

async function readProjectFile(p) {
  const [text, stat] = await Promise.all([fsp.readFile(p, 'utf8'), fsp.stat(p)]);
  return { path: p, text, mtime: stat.mtimeMs, kind: /\.json$/i.test(p) ? 'json' : 'ycad' };
}

/** เปิดไฟล์: ถ้าเปิดอยู่แล้วให้สลับไปหน้าต่างนั้น, ถ้าหน้าต่างปัจจุบันว่าง (ไม่ผูกไฟล์และไม่มีการแก้) ใช้หน้าต่างนั้น, ไม่งั้นเปิดหน้าต่างใหม่ */
async function openPath(p, preferWin) {
  p = path.resolve(p);
  if (!fs.existsSync(p)) {
    settings.removeRecent(p); rebuildMenuSoon();
    dialog.showErrorBox(APP_NAME, 'ไม่พบไฟล์\n' + p);
    return;
  }
  if (/\.ycad$/i.test(p)) {
    const open = allStates().find(s => s.filePath && samePath(s.filePath, p));
    if (open) { if (open.win.isMinimized()) open.win.restore(); open.win.focus(); return; }
  }
  let file;
  try { file = await readProjectFile(p); } catch (e) { dialog.showErrorBox(APP_NAME, 'อ่านไฟล์ไม่ได้\n' + e.message); return; }
  const st = stateOf(preferWin);
  if (st && !st.filePath && !st.dirty && st.loaded) {
    send(st.win, 'open-file', { file });
    st.win.focus();
  } else {
    createWindow({ type: 'file', file });
  }
}

function samePath(a, b) {
  return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

async function showOpenDialog(win, kind) {
  const isImport = kind === 'json';
  const r = await dialog.showOpenDialog(win, {
    title: isImport ? 'นำเข้าโครงการจากเวอร์ชันเว็บ (.json)' : 'เปิดโครงการ',
    defaultPath: settings.get().lastDir || app.getPath('documents'),
    properties: ['openFile', 'multiSelections'],
    filters: isImport
      ? [{ name: 'โครงการจากเวอร์ชันเว็บ (*.json)', extensions: ['json'] }]
      : [{ name: 'โครงการโยธาแคด (*.ycad, *.json)', extensions: ['ycad', 'json'] }, { name: 'ทุกไฟล์', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return;
  settings.set({ lastDir: path.dirname(r.filePaths[0]) });
  let target = win;
  for (const p of r.filePaths) { await openPath(p, target); target = null; }
}

// ---------------------------------------------------------------- IPC จากหน้าเว็บ
ipcMain.handle('ycad:ready', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const st = stateOf(win);
  if (!st) return {};
  const intent = st.intent || { type: 'new' };
  st.intent = { type: 'reload' };        // ถ้ากดโหลดหน้าใหม่ ไม่ต้องเปิดไฟล์ซ้ำ
  st.loaded = true;
  return {
    intent,
    // หน้าต่างแรกของโปรแกรมใช้โครงการล่าสุด (เหมือนเวอร์ชันเว็บ) หน้าต่างอื่นเริ่มโครงการใหม่
    firstWindow: windows.size === 1,
    appVersion: app.getVersion(),
    filePath: st.filePath,
  };
});

ipcMain.on('ycad:state', (e, s) => {
  const st = stateOf(BrowserWindow.fromWebContents(e.sender));
  if (!st) return;
  const prevTitle = st.title;
  if ('dirty' in s) st.dirty = !!s.dirty;
  if ('filePath' in s) st.filePath = s.filePath || null;
  if ('name' in s) st.name = s.name || '';
  const base = st.filePath ? path.basename(st.filePath) : (st.name || 'ไม่มีชื่อ');
  st.title = (st.dirty ? '● ' : '') + base + ' — ' + APP_NAME;
  if (st.title !== prevTitle) { st.win.setTitle(st.title); rebuildMenuSoon(); }
  if (st.filePath) settings.addRecent(st.filePath);
  if (st.dirty) flushStorageSoon();
});

// แอปเว็บเก็บงานอัตโนมัติไว้ใน localStorage แต่ Chromium เขียนลงดิสก์แบบหน่วงเวลา (อาจนานเป็นนาที)
// จึงสั่งเขียนลงดิสก์เองเป็นระยะ เพื่อให้กู้คืนงานได้ถ้าไฟดับ/โปรแกรมค้าง
let flushTimer = null;
function flushStorageSoon() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushStorage(); }, 3000);
}
function flushStorage() {
  try { session.defaultSession.flushStorageData(); } catch (_) { }
}

ipcMain.handle('ycad:save-project', async (e, { content, filePath, saveAs, suggestedName }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  let target = filePath;
  if (!target || saveAs) {
    const safe = String(suggestedName || 'โครงการ').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'โครงการ';
    const r = await dialog.showSaveDialog(win, {
      title: saveAs ? 'บันทึกเป็น' : 'บันทึกโครงการ',
      defaultPath: path.join(filePath ? path.dirname(filePath) : (settings.get().lastDir || app.getPath('documents')), safe + PROJECT_EXT),
      filters: [{ name: 'โครงการโยธาแคด (*.ycad)', extensions: ['ycad'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    target = r.filePath;
    if (!/\.ycad$/i.test(target)) target += PROJECT_EXT;
    settings.set({ lastDir: path.dirname(target) });
  }
  try {
    await writeAtomic(target, content);
    const stat = await fsp.stat(target);
    settings.addRecent(target);
    rebuildMenuSoon();
    return { ok: true, path: target, mtime: stat.mtimeMs };
  } catch (err) {
    dialog.showErrorBox(APP_NAME, 'บันทึกไฟล์ไม่สำเร็จ\n' + target + '\n\n' + err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ycad:open-dialog', (e, { kind } = {}) => showOpenDialog(BrowserWindow.fromWebContents(e.sender), kind));

const EXPORT_FILTERS = {
  pdf: 'PDF', dxf: 'DXF', zip: 'ZIP', xlsx: 'Excel', csv: 'CSV', ifc: 'IFC', png: 'รูปภาพ PNG',
  py: 'Python script', json: 'JSON',
};
ipcMain.handle('ycad:save-export', async (e, { name, data }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const s = settings.get();
  const dir = s.exportDir && fs.existsSync(s.exportDir) ? s.exportDir : app.getPath('documents');
  const clean = String(name || 'export').replace(/[\\/:*?"<>|]+/g, '_');
  const ext = path.extname(clean).slice(1).toLowerCase();
  let target;
  if (s.exportAsk !== false) {
    const r = await dialog.showSaveDialog(win, {
      title: 'ส่งออกไฟล์',
      defaultPath: path.join(dir, clean),
      filters: ext ? [{ name: (EXPORT_FILTERS[ext] || ext.toUpperCase()) + ` (*.${ext})`, extensions: [ext] }, { name: 'ทุกไฟล์', extensions: ['*'] }] : [],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    target = r.filePath;
    settings.set({ exportDir: path.dirname(target) });
  } else {
    target = uniquePath(path.join(dir, clean));
  }
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, typeof data === 'string' ? data : Buffer.from(data));
    return { ok: true, path: target };
  } catch (err) {
    dialog.showErrorBox(APP_NAME, 'ส่งออกไฟล์ไม่สำเร็จ\n' + target + '\n\n' + err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ycad:show-in-folder', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });

ipcMain.handle('ycad:ask', async (e, { message, detail, buttons, type }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showMessageBox(win, {
    type: type || 'question', title: APP_NAME, message, detail,
    buttons: buttons || ['ตกลง', 'ยกเลิก'], defaultId: 0, cancelId: (buttons || [0, 1]).length - 1, noLink: true,
  });
  return r.response;
});

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) {
    const q = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(q)) return q;
  }
}

async function writeAtomic(target, data) {
  const tmp = target + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, data);
  try { await fsp.rename(tmp, target); } catch (e) {
    // บางครั้ง Windows ล็อกไฟล์ปลายทาง (เช่น เปิดค้างไว้ในโปรแกรมอื่น) — ลองเขียนทับตรง ๆ
    await fsp.unlink(tmp).catch(() => {});
    await fsp.writeFile(target, data);
  }
}

// ---------------------------------------------------------------- เมนู
let menuTimer = null;
function rebuildMenuSoon() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(buildMenu, 120);
}

function cmd(name, extra) {
  return (_mi, win) => {
    if (!win) { if (name === 'new-window') createWindow(); return; }
    send(win, name, extra);
  };
}

function buildMenu() {
  const s = settings.get();
  const recent = s.recent || [];
  const focused = BrowserWindow.getFocusedWindow();
  const template = [
    {
      label: 'ไฟล์ (&F)',
      submenu: [
        { label: 'โครงการใหม่', accelerator: 'CmdOrCtrl+N', click: (_m, w) => newProjectIn(w) },
        { label: 'หน้าต่างใหม่', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow({ type: 'new' }) },
        { type: 'separator' },
        { label: 'เปิด…', accelerator: 'CmdOrCtrl+O', click: (_m, w) => showOpenDialog(w, 'ycad') },
        {
          label: 'เปิดล่าสุด',
          submenu: recent.length
            ? [
              ...recent.map((p, i) => ({
                label: `${i < 9 ? '&' + (i + 1) : i + 1}  ${path.basename(p)}`,
                sublabel: path.dirname(p),
                toolTip: p,
                click: (_m, w) => openPath(p, w),
              })),
              { type: 'separator' },
              { label: 'ล้างรายการ', click: () => { settings.set({ recent: [] }); app.clearRecentDocuments(); rebuildMenuSoon(); } },
            ]
            : [{ label: '(ยังไม่มี)', enabled: false }],
        },
        { label: 'นำเข้าโครงการจากเวอร์ชันเว็บ (.json)…', click: (_m, w) => showOpenDialog(w, 'json') },
        { type: 'separator' },
        { label: 'บันทึก', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: 'บันทึกเป็น…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('save-as') },
        { type: 'separator' },
        {
          label: 'ส่งออก',
          submenu: [
            { label: 'แผ่นงานทั้งหมดเป็น PDF…', accelerator: 'CmdOrCtrl+P', click: cmd('export', { what: 'pdf' }) },
            { label: 'แผ่นงานที่เปิดอยู่เป็น PDF…', click: cmd('export', { what: 'pdf1' }) },
            { label: 'DXF ทุกชั้นและรูปตัด (.zip)…', click: cmd('export', { what: 'dxf' }) },
            { label: 'ประมาณราคา BOQ / Excel (ปร.4–ปร.6)…', click: cmd('export', { what: 'boq' }) },
            { label: 'IFC สำหรับ Revit / ArchiCAD…', click: cmd('export', { what: 'ifc' }) },
            { type: 'separator' },
            { label: 'ปริมาณงาน (.csv)…', click: cmd('export', { what: 'csv' }) },
            { label: 'ภาพแปลน (.png)…', click: cmd('export', { what: 'png2' }) },
            { label: 'ภาพ 3D ตามหน้าจอ (.png)…', click: cmd('export', { what: 'png3' }) },
            { label: 'ภาพ 3D 4K (.png)…', click: cmd('export', { what: 'png3k4' }) },
            { label: 'สคริปต์สร้างโมเดลใน Revit (.py)…', click: cmd('export', { what: 'rvt' }) },
            { type: 'separator' },
            {
              label: 'ถามตำแหน่งบันทึกทุกครั้ง', type: 'checkbox', checked: s.exportAsk !== false,
              click: (mi) => { settings.set({ exportAsk: mi.checked }); rebuildMenuSoon(); },
            },
            { label: 'เลือกโฟลเดอร์ส่งออก…', click: (_m, w) => chooseExportDir(w) },
            {
              label: 'เปิดโฟลเดอร์ส่งออก', enabled: !!s.exportDir,
              click: () => s.exportDir && shell.openPath(s.exportDir),
            },
          ],
        },
        { type: 'separator' },
        { label: 'จัดการโครงการในโปรแกรม…', click: cmd('webmenu', { m: 'proj' }) },
        { type: 'separator' },
        { label: 'ปิดหน้าต่าง', accelerator: 'CmdOrCtrl+W', click: (_m, w) => w && w.close() },
        { label: 'ออกจากโปรแกรม', accelerator: 'Alt+F4', click: () => quitApp() },
      ],
    },
    {
      label: 'แก้ไข (&E)',
      submenu: [
        // ปุ่มลัดเหล่านี้แอปเว็บจัดการเองอยู่แล้ว จึงไม่ลงทะเบียนซ้ำ (registerAccelerator: false) กันทำงานสองครั้ง
        { label: 'เลิกทำ', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: cmd('undo') },
        { label: 'ทำซ้ำ', accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, click: cmd('redo') },
        { type: 'separator' },
        { label: 'ตัด', role: 'cut', accelerator: 'CmdOrCtrl+X', registerAccelerator: false },
        { label: 'คัดลอก', role: 'copy', accelerator: 'CmdOrCtrl+C', registerAccelerator: false },
        { label: 'วาง', role: 'paste', accelerator: 'CmdOrCtrl+V', registerAccelerator: false },
        { type: 'separator' },
        { label: 'เลือกทั้งหมดในชั้นนี้', accelerator: 'CmdOrCtrl+A', registerAccelerator: false, click: cmd('select-all') },
        { label: 'ยกเลิกคำสั่ง / ยกเลิกการเลือก', accelerator: 'Esc', registerAccelerator: false, click: cmd('key', { key: 'Escape' }) },
        { label: 'ลบที่เลือก', accelerator: 'Delete', registerAccelerator: false, click: cmd('key', { key: 'Delete' }) },
        { type: 'separator' },
        { label: 'ข้อมูลโครงการ / ตั้งค่า…', click: cmd('webmenu', { m: 'proj' }) },
      ],
    },
    {
      label: 'มุมมอง (&V)',
      submenu: [
        { label: '2D', accelerator: 'CmdOrCtrl+1', click: cmd('view', { v: 'm2d' }) },
        { label: '2D + 3D', accelerator: 'CmdOrCtrl+2', click: cmd('view', { v: 'split' }) },
        { label: '3D', accelerator: 'CmdOrCtrl+3', click: cmd('view', { v: 'm3d' }) },
        { label: 'รูปตัด', accelerator: 'CmdOrCtrl+4', click: cmd('view', { v: 'msec' }) },
        { label: 'แผ่นงาน', accelerator: 'CmdOrCtrl+5', click: cmd('view', { v: 'msheet' }) },
        { type: 'separator' },
        {
          label: 'มุมกล้อง 3D',
          submenu: [
            ['iso', 'ไอโซเมตริก'], ['top', 'มุมบน'], ['front', 'ด้านหน้า'], ['back', 'ด้านหลัง'],
            ['left', 'ด้านซ้าย'], ['side', 'ด้านขวา'], ['fit', 'พอดีจอ'],
          ].map(([k, l]) => ({ label: l, click: cmd('cam', { k }) })),
        },
        { label: 'ซูมแปลนพอดีจอ', accelerator: 'CmdOrCtrl+Shift+F', click: cmd('fit') },
        { label: 'แสดง/ซ่อนแผงด้านข้าง', accelerator: 'CmdOrCtrl+B', click: cmd('side') },
        { label: 'สลับธีม (CAD / สว่าง / มืด)', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('webmenu', { m: 'theme' }) },
        { type: 'separator' },
        { label: 'ขยายตัวอักษร', role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { label: 'ย่อตัวอักษร', role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { label: 'ขนาดปกติ', role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { type: 'separator' },
        { label: 'เต็มจอ', role: 'togglefullscreen', accelerator: 'F11' },
      ],
    },
    {
      label: 'หน้าต่าง (&W)',
      submenu: [
        { label: 'หน้าต่างใหม่', click: () => createWindow({ type: 'new' }) },
        { label: 'ย่อหน้าต่าง', role: 'minimize' },
        { type: 'separator' },
        ...allStates().map((st) => ({
          label: st.title.replace(' — ' + APP_NAME, ''),
          type: 'radio', checked: st.win === focused,
          click: () => { if (st.win.isMinimized()) st.win.restore(); st.win.focus(); },
        })),
      ],
    },
    {
      label: 'ช่วยเหลือ (&H)',
      submenu: [
        { label: 'คู่มือการใช้งาน', accelerator: 'F1', click: cmd('help') },
        { label: 'ตรวจหาเวอร์ชันใหม่…', click: (_m, w) => updater.checkNow(w, true) },
        { type: 'separator' },
        { label: 'เปิดโฟลเดอร์ข้อมูลโปรแกรม', click: () => shell.openPath(app.getPath('userData')) },
        {
          label: 'สำหรับนักพัฒนา',
          submenu: [
            { label: 'เครื่องมือนักพัฒนา', role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
            { label: 'โหลดหน้าใหม่', role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' },
          ],
        },
        { type: 'separator' },
        { label: 'เกี่ยวกับโยธาแคด', click: (_m, w) => showAbout(w) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (process.platform === 'win32') {
    // รายการในทาสก์บาร์ (คลิกขวาที่ไอคอน)
    app.setUserTasks([{
      program: process.execPath, arguments: app.isPackaged ? '--new-window' : `"${app.getAppPath()}" --new-window`,
      iconPath: process.execPath, iconIndex: 0, title: 'หน้าต่างใหม่', description: 'เปิดโยธาแคดอีกหน้าต่าง',
    }]);
  }
}

/** โครงการใหม่: ถ้าหน้าต่างนี้ว่างอยู่ (ไม่ผูกไฟล์ ไม่มีงานค้าง) ใช้หน้าต่างนี้ ไม่งั้นเปิดหน้าต่างใหม่ */
function newProjectIn(win) {
  const st = stateOf(win);
  if (st && !st.filePath && !st.dirty && st.loaded) send(win, 'new-project');
  else createWindow({ type: 'new' });
}

async function chooseExportDir(win) {
  const r = await dialog.showOpenDialog(win, {
    title: 'เลือกโฟลเดอร์สำหรับส่งออกไฟล์', properties: ['openDirectory', 'createDirectory'],
    defaultPath: settings.get().exportDir || app.getPath('documents'),
  });
  if (!r.canceled && r.filePaths[0]) { settings.set({ exportDir: r.filePaths[0] }); rebuildMenuSoon(); }
}

function readBuildInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'build-info.json'), 'utf8')); } catch (_) { return {}; }
}

function showAbout(win) {
  const bi = readBuildInfo();
  dialog.showMessageBox(win, {
    type: 'info', title: 'เกี่ยวกับโยธาแคด', icon: ICON,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: [
      'โปรแกรมเขียนแบบอาคาร 2D / 3D',
      bi.webVersion ? `ตัวแอป: ${bi.webVersion} (${bi.webSource || ''})` : '',
      `Electron ${process.versions.electron} • Chromium ${process.versions.chrome}`,
      '',
      'Pattarakorn Suttipol — Engineering & Design',
    ].filter((x) => x !== null).join('\n'),
    buttons: ['ตกลง'], noLink: true,
  });
}

function quitApp() {
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- เริ่มโปรแกรม
app.on('second-instance', (_e, argv) => {
  const files = filesFromArgv(argv);
  if (files.length) files.forEach((f) => openPath(f, null));
  else if (argv.includes('--new-window') || !windows.size) createWindow({ type: 'new' });
  else {
    const w = allStates()[0].win;
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

// เพิ่มไฟล์ในรายการล่าสุดของ Windows (Jump List) ทุกครั้งที่ settings บันทึก
settings.onRecent((p) => { try { app.addRecentDocument(p); } catch (_) { } rebuildMenuSoon(); });

app.whenReady().then(async () => {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(APP_DIR, rel));
    if (!file.startsWith(APP_DIR)) return new Response('forbidden', { status: 403 });
    try {
      const buf = await fsp.readFile(file);
      return new Response(buf, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch (_) {
      return new Response('not found', { status: 404 });
    }
  });

  // สำรอง: ถ้ามีการดาวน์โหลดผ่านลิงก์ในหน้าเว็บที่ bridge ไม่ได้ดักไว้ ให้เปิดหน้าต่างบันทึกที่โฟลเดอร์ส่งออก
  session.defaultSession.on('will-download', (_e, item) => {
    const s = settings.get();
    const dir = s.exportDir && fs.existsSync(s.exportDir) ? s.exportDir : app.getPath('documents');
    item.setSaveDialogOptions({ title: 'ส่งออกไฟล์', defaultPath: path.join(dir, item.getFilename()) });
    item.once('done', (_ev, state) => {
      if (state === 'completed') settings.set({ exportDir: path.dirname(item.getSavePath()) });
    });
  });

  if (!fs.existsSync(path.join(APP_DIR, 'index.html'))) {
    dialog.showErrorBox(APP_NAME, 'ไม่พบ app/index.html — รัน "npm run prepare-web" ก่อน');
    app.quit();
    return;
  }

  buildMenu();
  const files = filesFromArgv(process.argv);
  if (files.length) {
    createWindow({ type: 'file', file: await readProjectFile(files[0]).catch(() => null) || undefined, restoreLast: false });
    for (const f of files.slice(1)) await openPath(f, null);
  } else {
    createWindow({ type: 'restore' });
  }
  setInterval(flushStorage, 20000);
  updater.init(() => allStates().map((s) => s.win), { beforeInstall: closeAllForInstall });
});

/** ปิดทุกหน้าต่าง (ถามบันทึกตามปกติ) เพื่อติดตั้งอัปเดต */
function closeAllForInstall() {
  quitting = true;
  for (const st of allStates()) st.win.close();
}

app.on('window-all-closed', () => {
  if (updater.hasPendingInstall()) { updater.installNow(); return; }
  app.quit();
});

app.on('before-quit', () => { quitting = true; flushStorage(); });
