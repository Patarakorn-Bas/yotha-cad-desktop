/* desktop-bridge.js — ต่อแอปโยธาแคดเวอร์ชันเว็บเข้ากับโปรแกรม Windows
 *
 * ไฟล์นี้ถูกแทรกท้ายหน้า index.html โดย scripts/prepare-web.js และทำงานใน "โลกเดียวกับแอปเว็บ"
 * จึงเรียกตัวแปร/ฟังก์ชันของแอปได้โดยตรง
 *
 * ── สัญญากับแอปเว็บ (ถ้าเวอร์ชันใหม่เปลี่ยนชื่อเหล่านี้ ต้องแก้ไฟล์นี้ตาม) ──
 *   ตัวแปร:  S (ข้อมูลโมเดล), cur (ชั้นปัจจุบัน), projId (โครงการที่เปิดอยู่)
 *   ฟังก์ชัน: saveFile(name,data), importAsProject(s,cur), newProject(name,sample), openProject(id),
 *            pIndex(), pLoad(id), pWrite(id,data,meta), pSaveCurrent(), fixCur(), resetSession(),
 *            changed(), undo(), redo(), toast(msg)
 *   ปุ่ม:    #menu button[data-m=…], #viewSeg button[data-v=…], [data-cam=…], #zfit, #sideB, #helpB, #hPdf, #hPdf1
 * ถ้าบางตัวหายไป bridge จะข้ามความสามารถนั้นและแจ้งใน Console (Ctrl+Shift+I) แทนการทำให้โปรแกรมพัง
 */
(function () {
  'use strict';
  var D = window.ycadDesktop;
  if (!D) return;

  // ---------- ตัวช่วยเข้าถึงตัวแปรของแอปเว็บอย่างปลอดภัย ----------
  var gEval = eval; // indirect eval → มองเห็นตัวแปรระดับบนสุด (let/const/function) ของแอป
  function has(name) { try { return typeof gEval(name) !== 'undefined'; } catch (e) { return false; } }
  function fn(name) { try { var f = gEval(name); return typeof f === 'function' ? f : null; } catch (e) { return null; } }
  function getS() { try { return gEval('S'); } catch (e) { return null; } }
  function getCur() { try { return gEval('cur'); } catch (e) { return null; } }
  function getPid() { try { return gEval('projId'); } catch (e) { return null; } }
  function setVar(name, value) { window.__ycadTmp = value; try { gEval(name + '=window.__ycadTmp'); } finally { delete window.__ycadTmp; } }
  function $(q) { return document.querySelector(q); }
  function click(q) { var b = $(q); if (b) { b.click(); return true; } return false; }

  var missing = ['S', 'cur', 'projId', 'saveFile', 'importAsProject', 'newProject', 'openProject', 'pIndex', 'pLoad', 'pWrite',
    'pSaveCurrent', 'fixCur', 'resetSession', 'changed', 'undo', 'redo', 'toast'].filter(function (n) { return !has(n); });
  if (missing.length) console.warn('[โยธาแคด desktop] แอปเว็บเวอร์ชันนี้ไม่มี:', missing.join(', '), '— บางเมนูอาจใช้ไม่ได้');

  var webVersion = (document.querySelector('meta[name="yothacad-web-version"]') || {}).content || '';
  var appVersion = '';

  // ---------- สถานะของหน้าต่างนี้ ----------
  var filePath = null;     // ไฟล์ .ycad ที่ผูกกับหน้าต่างนี้
  var boundPid = null;     // โครงการภายในแอปที่ผูกกับไฟล์
  var savedSig = null;     // ข้อมูล ณ ครั้งที่บันทึก/เปิดล่าสุด (ใช้ตรวจว่ามีงานค้าง)
  var dirty = false;
  var maybeChanged = true;
  var lastSent = '';

  function sig() { try { return JSON.stringify(getS()); } catch (e) { return ''; } }
  function projName() { var s = getS(); return (s && s.proj && s.proj.name) || 'โครงการ'; }

  // แผนที่ "โครงการภายใน ↔ ไฟล์ .ycad" เก็บใน localStorage (ใช้ร่วมทุกหน้าต่าง)
  var FM_KEY = 'yothacad-desktop-files';
  function fileMap() { try { return JSON.parse(localStorage.getItem(FM_KEY) || '{}'); } catch (e) { return {}; } }
  function setFileMap(m) { try { localStorage.setItem(FM_KEY, JSON.stringify(m)); } catch (e) { } }
  function samePath(a, b) { return a && b && a.toLowerCase() === b.toLowerCase(); }
  function projectExists(pid) { var P = fn('pIndex'); return !!(P && P().some(function (p) { return p.id === pid; })); }

  function markClean() { savedSig = sig(); dirty = false; maybeChanged = false; pushState(true); }

  function pushState(force) {
    var st = { dirty: dirty, filePath: filePath, name: projName() };
    var k = JSON.stringify(st);
    if (force || k !== lastSent) { lastSent = k; D.setState(st); }
  }

  // ผู้ใช้สลับโครงการจากเมนู "จัดการโครงการ" ในแอป → ผูกหน้าต่างกับไฟล์ของโครงการนั้น (ถ้ามี)
  function checkSwitch() {
    var pid = getPid();
    if (boundPid === null) { boundPid = pid; return false; }
    if (pid === boundPid) return false;
    filePath = fileMap()[pid] || null;
    boundPid = pid;
    markClean();
    return true;
  }

  // ตรวจทุก 0.8 วินาที ว่ามีงานที่ยังไม่บันทึกหรือไม่
  function tick() {
    if (checkSwitch()) return;
    if (maybeChanged) {
      maybeChanged = false;
      dirty = savedSig !== null && sig() !== savedSig;
    }
    pushState(false);
  }

  // ดักฟังก์ชัน changed() ของแอป เพื่อรู้ว่ามีการแก้ไข (ไม่ต้องเทียบข้อมูลทุกครั้ง)
  (function hookChanged() {
    var orig = fn('changed');
    if (!orig) { setInterval(function () { maybeChanged = true; }, 1500); return; }
    setVar('changed', function () {
      var r = orig.apply(this, arguments);
      if (!checkSwitch()) maybeChanged = true;
      return r;
    });
  })();

  // ---------- ส่งออกไฟล์: ใช้หน้าต่างบันทึกของ Windows แทนการดาวน์โหลดของเบราว์เซอร์ ----------
  async function toBytes(data) {
    if (data == null) return '';
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return String(data);
  }
  async function desktopSaveFile(name, data) {
    try {
      var r = await D.saveExport(name, await toBytes(data));
      if (r && r.ok) notify('บันทึก ' + baseName(r.path) + ' แล้ว', 'เปิดโฟลเดอร์', function () { D.showInFolder(r.path); });
    } catch (e) {
      var t = fn('toast'); if (t) t('บันทึกไม่สำเร็จ: ' + (e && e.message || e));
    }
  }
  if (fn('saveFile')) setVar('saveFile', desktopSaveFile);
  window.ycadSaveFile = desktopSaveFile;
  function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }

  // ---------- บันทึก / เปิด .ycad ----------
  function serialize() {
    return JSON.stringify({
      app: 'yothacad', format: 'ycad', formatVersion: 1,
      savedAt: new Date().toISOString(), savedWith: { desktop: appVersion, web: webVersion },
      S: getS(), cur: getCur(),
    });
  }

  async function save(saveAs) {
    var flush = fn('pSaveCurrent'); if (flush) { try { flush(); } catch (e) { } }
    var r = await D.saveProject({ content: serialize(), filePath: filePath, saveAs: !!saveAs, suggestedName: projName() });
    if (!r || !r.ok) return false;
    filePath = r.path;
    boundPid = getPid();
    var m = fileMap();
    Object.keys(m).forEach(function (k) { if (samePath(m[k], filePath) && k !== boundPid) delete m[k]; });
    if (boundPid) m[boundPid] = filePath;
    setFileMap(m);
    markClean();
    notify('บันทึก ' + baseName(filePath) + ' แล้ว');
    return true;
  }

  function parseProject(text) {
    var d = JSON.parse(text);
    var s = d && (d.S || d);
    if (!s || !Array.isArray(s.levels) || !Array.isArray(s.els) || !s.levels.length) throw new Error('not a project');
    return { S: s, cur: d.cur };
  }

  function afterLoad() {
    setTimeout(function () {
      var f2 = fn('fit2'), cv = fn('camView');
      try { if (f2) f2(); if (cv) cv('iso'); } catch (e) { }
    }, 40);
  }

  async function openFile(file) {
    var d;
    try { d = parseProject(file.text); } catch (e) {
      await D.ask({ type: 'error', message: 'ไฟล์นี้ไม่ใช่โครงการโยธาแคด', detail: file.path, buttons: ['ตกลง'] });
      return false;
    }
    var importAs = fn('importAsProject');
    if (!importAs) { await D.ask({ type: 'error', message: 'แอปเวอร์ชันนี้ไม่รองรับการเปิดไฟล์', buttons: ['ตกลง'] }); return false; }

    // ไม่ให้แอปบันทึกทับโครงการเดิมของหน้าต่างนี้ระหว่างสลับ
    setVar('projId', null);

    if (file.kind === 'json') {
      // นำเข้าจากเวอร์ชันเว็บ: สร้างเป็นโครงการใหม่ในโปรแกรม ยังไม่ผูกไฟล์ (กด Ctrl+S เพื่อบันทึกเป็น .ycad)
      importAs(d.S, d.cur);
      filePath = null; boundPid = getPid();
      afterLoad();
      setTimeout(markClean, 120);
      notify('นำเข้า ' + baseName(file.path) + ' แล้ว — กด Ctrl+S เพื่อบันทึกเป็นไฟล์ .ycad');
      return true;
    }

    var m = fileMap();
    var pid = Object.keys(m).find(function (k) { return samePath(m[k], file.path) && projectExists(k); });
    var recovered = false;
    if (pid && fn('pLoad') && fn('pWrite') && fn('openProject')) {
      var old = fn('pLoad')(pid);
      var meta = fn('pIndex')().find(function (p) { return p.id === pid; }) || {};
      var differs = old && old.S && JSON.stringify(old.S) !== JSON.stringify(d.S);
      if (differs && (meta.updated || 0) > file.mtime + 2000) {
        var ans = await D.ask({
          type: 'warning',
          message: 'พบงานของไฟล์นี้ที่ยังไม่ได้บันทึก',
          detail: 'ไฟล์ ' + baseName(file.path) + ' บันทึกล่าสุด ' + fmt(file.mtime) +
            '\nแต่ในโปรแกรมมีงานที่แก้ไขล่าสุด ' + fmt(meta.updated) + ' (อาจเกิดจากโปรแกรมปิดไม่ปกติ)\n\nต้องการใช้งานฉบับไหน?',
          buttons: ['กู้คืนงานที่ยังไม่ได้บันทึก', 'เปิดจากไฟล์'],
        });
        recovered = ans === 0;
      }
      if (!recovered) {
        fn('pWrite')(pid, { S: d.S, cur: d.cur || d.S.levels[0].id }, { name: (d.S.proj && d.S.proj.name) || baseName(file.path), updated: file.mtime });
      }
      fn('openProject')(pid);
    } else {
      importAs(d.S, d.cur);
      pid = getPid();
      m[pid] = file.path;
      setFileMap(m);
    }
    filePath = file.path;
    boundPid = getPid();
    afterLoad();
    if (recovered) {
      // ค่าอ้างอิง = ข้อมูลในไฟล์ (ผ่านการจัดรูปแบบของแอปแล้ว) → หน้าต่างจะแสดงว่ามีงานค้าง
      savedSig = JSON.stringify(normalizeLike(d.S));
      maybeChanged = true;
      tick();
    } else {
      setTimeout(markClean, 120);
    }
    return true;
  }

  // ทำให้ข้อมูลในไฟล์อยู่ในรูปเดียวกับที่แอปจัดให้ (fixCur เติมค่าเริ่มต้น) เพื่อเทียบได้ถูกต้อง
  function normalizeLike(s) {
    var fc = fn('fixCur');
    if (!fc) return s;
    var keepS = getS(), keepCur = getCur();
    try {
      setVar('S', JSON.parse(JSON.stringify(s)));
      setVar('cur', s.levels[0].id);
      fc();
      return getS();
    } catch (e) { return s; } finally { setVar('S', keepS); setVar('cur', keepCur); }
  }

  function fmt(t) { try { return new Date(t).toLocaleString('th-TH'); } catch (e) { return String(t); } }

  // ---------- ปิดหน้าต่าง ----------
  async function discardForClose() {
    // ไฟล์ที่ผูกไว้: คืนข้อมูลในโปรแกรมกลับเป็นฉบับที่บันทึกล่าสุด (ไม่ให้ขึ้นกู้คืนครั้งหน้า)
    if (filePath && savedSig) {
      try {
        setVar('S', JSON.parse(savedSig));
        var fc = fn('fixCur'); if (fc) fc();
        var ps = fn('pSaveCurrent'); if (ps) ps();
      } catch (e) { }
    }
    return true;
  }

  // ---------- การแจ้งเตือนเล็ก ๆ มุมจอ (มีปุ่มกดได้) ----------
  var nt, ntTimer;
  function notify(msg, actLabel, act) {
    if (!nt) {
      nt = document.createElement('div');
      nt.id = 'ycadNotify';
      nt.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;display:none;align-items:center;gap:12px;' +
        'max-width:min(520px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;background:#13233a;color:#fff;' +
        'font:500 13px/1.4 "IBM Plex Sans Thai",Sarabun,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid #2b78d0';
      document.body.appendChild(nt);
    }
    nt.innerHTML = '';
    var sp = document.createElement('span'); sp.textContent = msg; nt.appendChild(sp);
    if (actLabel && act) {
      var b = document.createElement('button');
      b.textContent = actLabel;
      b.style.cssText = 'flex:none;border:0;border-radius:6px;padding:5px 10px;background:#2b78d0;color:#fff;font:inherit;cursor:pointer';
      b.onclick = function () { act(); nt.style.display = 'none'; };
      nt.appendChild(b);
    }
    nt.style.display = 'flex';
    clearTimeout(ntTimer);
    ntTimer = setTimeout(function () { nt.style.display = 'none'; }, actLabel ? 6000 : 3000);
  }

  // ---------- คำสั่งจากเมนู ----------
  function inField() {
    var a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  }
  function key(k, mods) {
    window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));
  }
  function webMenu(m) { return click('#menu button[data-m="' + m + '"]'); }

  var EXPORTS = {
    pdf: function () { if (!click('#hPdf')) { var f = fn('exportPDF'); if (f) f(getS().sheets || []); } },
    pdf1: function () { if (!click('#hPdf1')) EXPORTS.pdf(); },
  };

  D.onCommand(async function (msg) {
    var c = msg.cmd, result = { ok: true };
    try {
      switch (c) {
        case 'save': result.ok = await save(false); break;
        case 'save-as': result.ok = await save(true); break;
        case 'save-for-close': result.ok = await save(false); break;
        case 'discard-for-close': result.ok = await discardForClose(); break;
        case 'open-file': result.ok = await openFile(msg.file); break;
        case 'new-project': {
          var np = fn('newProject'), ix = fn('pIndex');
          if (np) { np('โครงการใหม่ ' + ((ix ? ix().length : 0) + 1), false); filePath = null; boundPid = getPid(); setTimeout(markClean, 120); }
          break;
        }
        case 'export':
          if (EXPORTS[msg.what]) EXPORTS[msg.what]();
          else webMenu(msg.what);
          break;
        case 'webmenu': webMenu(msg.m); break;
        case 'undo': if (inField()) document.execCommand('undo'); else if (fn('undo')) fn('undo')(); else key('z', { ctrlKey: true }); break;
        case 'redo': if (inField()) document.execCommand('redo'); else if (fn('redo')) fn('redo')(); else key('y', { ctrlKey: true }); break;
        case 'select-all': if (inField()) document.execCommand('selectAll'); else key('a', { ctrlKey: true }); break;
        case 'key':
          if (inField()) { if (msg.key === 'Delete') document.execCommand('forwardDelete'); else document.activeElement.blur(); }
          else key(msg.key);
          break;
        case 'view': if (!click('#viewSeg button[data-v="' + msg.v + '"]') && fn('setView')) fn('setView')(msg.v); break;
        case 'cam': {
          var views = $('#views');
          if (views && /\b(m2d|msec|msheet)\b/.test(views.className)) click('#viewSeg button[data-v="split"]');
          setTimeout(function () { click('[data-cam="' + msg.k + '"]'); }, 60);
          break;
        }
        case 'fit': click('#zfit'); break;
        case 'side': click('#sideB'); break;
        case 'help': click('#helpB'); break;
        default: result = { ok: false, unknown: c };
      }
    } catch (e) {
      console.error('[โยธาแคด desktop]', c, e);
      result = { ok: false, error: String(e && e.message || e) };
    }
    if (msg.requestId) D.reply(msg.requestId, result);
  });

  // ---------- ปรับหน้าตาเล็กน้อยสำหรับโปรแกรม Windows ----------
  (function tweakUi() {
    var inst = $('#instB'); if (inst) inst.style.display = 'none';      // ปุ่ม "ติดตั้งแอป" (PWA) ไม่จำเป็นแล้ว
    var fi = $('#fileIn'); if (fi) fi.setAttribute('accept', '.json,.ycad,application/json');
  })();

  // ---------- เริ่มต้น ----------
  D.ready().then(async function (r) {
    r = r || {};
    appVersion = r.appVersion || '';
    var intent = r.intent || { type: 'new' };
    if (intent.type === 'file' && intent.file) {
      var ok = await openFile(intent.file);
      if (!ok) intent = { type: r.firstWindow ? 'restore' : 'new' };
      else { setInterval(tick, 800); return; }
    }
    if (intent.type === 'new') {
      var np = fn('newProject'), ix = fn('pIndex');
      if (np) { setVar('projId', null); np('โครงการใหม่ ' + ((ix ? ix().length : 0) + 1), false); }
    } else if (intent.type === 'reload' && r.filePath) {
      filePath = r.filePath;
    }
    boundPid = getPid();
    if (!filePath) filePath = fileMap()[boundPid] || null;
    setTimeout(markClean, 150);
    setInterval(tick, 800);
  });
})();
