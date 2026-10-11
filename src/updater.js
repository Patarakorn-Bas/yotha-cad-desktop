// updater.js — อัปเดตอัตโนมัติจาก GitHub Releases (electron-updater)
// ทำงานเฉพาะตัวที่ติดตั้งด้วย Setup.exe เท่านั้น (ไม่ทำงานตอนรัน npm start)
'use strict';
const { app, dialog, BrowserWindow } = require('electron');

let autoUpdater = null;
let getWindows = () => [];
let hooks = {};
let pendingInstall = false;
let downloaded = null;
let manualCheck = false;
let busy = false;

function log(...a) { console.log('[updater]', ...a); }

function init(windowsFn, opts = {}) {
  getWindows = windowsFn;
  hooks = opts;
  if (!app.isPackaged) { log('ข้าม (ไม่ได้รันจากตัวติดตั้ง)'); return; }
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) { log('ไม่มี electron-updater', e.message); return; }

  autoUpdater.autoDownload = false;          // ถามผู้ใช้ก่อนดาวน์โหลด
  autoUpdater.autoInstallOnAppQuit = true;   // ดาวน์โหลดแล้วแต่ยังไม่ติดตั้ง → ติดตั้งตอนปิดโปรแกรม
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };

  autoUpdater.on('update-available', async (info) => {
    busy = false;
    const win = focusWin();
    const notes = plainNotes(info.releaseNotes);
    const { response } = await dialog.showMessageBox(win, {
      type: 'info', title: 'มีโยธาแคดเวอร์ชันใหม่',
      message: `มีเวอร์ชันใหม่ ${info.version} (ตอนนี้ใช้ ${app.getVersion()})`,
      detail: (notes ? notes.slice(0, 1200) + '\n\n' : '') + 'ดาวน์โหลดตอนนี้เลยหรือไม่? ระหว่างดาวน์โหลดใช้งานต่อได้ตามปกติ',
      buttons: ['ดาวน์โหลด', 'ภายหลัง'], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (response === 0) {
      autoUpdater.downloadUpdate().catch((e) => showError(e));
    }
  });

  autoUpdater.on('update-not-available', () => {
    busy = false;
    if (manualCheck) {
      dialog.showMessageBox(focusWin(), {
        type: 'info', title: 'ตรวจหาเวอร์ชันใหม่', message: 'คุณใช้เวอร์ชันล่าสุดแล้ว',
        detail: 'โยธาแคด ' + app.getVersion(), buttons: ['ตกลง'], noLink: true,
      });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    for (const w of getWindows()) if (!w.isDestroyed()) w.setProgressBar(p.percent / 100);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    downloaded = info;
    for (const w of getWindows()) if (!w.isDestroyed()) w.setProgressBar(-1);
    const { response } = await dialog.showMessageBox(focusWin(), {
      type: 'info', title: 'พร้อมติดตั้งเวอร์ชันใหม่',
      message: `ดาวน์โหลดโยธาแคด ${info.version} เรียบร้อย`,
      detail: 'ติดตั้งตอนนี้ (โปรแกรมจะถามให้บันทึกงานก่อนปิด แล้วเปิดใหม่ให้อัตโนมัติ) หรือติดตั้งเมื่อปิดโปรแกรมครั้งถัดไป',
      buttons: ['ติดตั้งและเปิดใหม่', 'ติดตั้งเมื่อปิดโปรแกรม'], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (response === 0) {
      pendingInstall = true;
      if (!getWindows().length) installNow();
      else if (hooks.beforeInstall) hooks.beforeInstall();
    }
  });

  autoUpdater.on('error', (e) => {
    busy = false;
    for (const w of getWindows()) if (!w.isDestroyed()) w.setProgressBar(-1);
    log('error', e && e.message);
    if (manualCheck) showError(e);
  });

  // ตรวจครั้งแรกหลังเปิดโปรแกรม 8 วินาที แล้วทุก 6 ชั่วโมง
  setTimeout(() => checkNow(null, false), 8000);
  setInterval(() => checkNow(null, false), 6 * 60 * 60 * 1000);
}

function checkNow(_win, manual) {
  if (!app.isPackaged || !autoUpdater) {
    if (manual) {
      dialog.showMessageBox(focusWin(), {
        type: 'info', title: 'ตรวจหาเวอร์ชันใหม่',
        message: 'ตรวจหาเวอร์ชันใหม่ได้เฉพาะโปรแกรมที่ติดตั้งจาก Setup.exe',
        buttons: ['ตกลง'], noLink: true,
      });
    }
    return;
  }
  if (downloaded && manual) {
    pendingInstall = true;
    if (hooks.beforeInstall) hooks.beforeInstall();
    return;
  }
  if (busy) return;
  busy = true;
  manualCheck = !!manual;
  autoUpdater.checkForUpdates().catch((e) => { busy = false; if (manual) showError(e); });
}

function showError(e) {
  dialog.showMessageBox(focusWin(), {
    type: 'warning', title: 'อัปเดตไม่สำเร็จ',
    message: 'ตรวจหรือดาวน์โหลดเวอร์ชันใหม่ไม่สำเร็จ',
    detail: 'ตรวจการเชื่อมต่ออินเทอร์เน็ต แล้วลองใหม่จากเมนู ช่วยเหลือ → ตรวจหาเวอร์ชันใหม่\n\n' + ((e && e.message) || e || '').toString().slice(0, 500),
    buttons: ['ตกลง'], noLink: true,
  });
}

function plainNotes(n) {
  if (!n) return '';
  if (Array.isArray(n)) n = n.map((x) => x.note || '').join('\n');
  return String(n).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}

function focusWin() {
  return BrowserWindow.getFocusedWindow() || getWindows()[0] || undefined;
}

function hasPendingInstall() { return pendingInstall && !!downloaded; }
function cancelPendingInstall() { pendingInstall = false; }
function installNow() {
  if (!autoUpdater) return app.quit();
  // isSilent=false: แสดงหน้าติดตั้ง, isForceRunAfter=true: เปิดโปรแกรมใหม่หลังติดตั้ง
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

module.exports = { init, checkNow, hasPendingInstall, cancelPendingInstall, installNow };
