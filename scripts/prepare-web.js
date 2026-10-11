#!/usr/bin/env node
/**
 * prepare-web.js — เตรียมไฟล์ HTML เวอร์ชันเว็บให้ทำงานในโปรแกรม Windows แบบออฟไลน์
 *
 * ทำอะไรบ้าง
 *   1. หาไฟล์ .html ในโฟลเดอร์ web/ (ต้องมีไฟล์เดียว ชื่ออะไรก็ได้)
 *   2. เปลี่ยน Three.js จาก CDN → ไฟล์ในเครื่อง (vendor/three.min.js)
 *   3. เปลี่ยน Google Fonts → ฟอนต์ในเครื่อง (vendor/fonts/…)
 *   4. คัดลอก exceljs.min.js ไว้ข้าง index.html (แอปจะโหลดไฟล์นี้ก่อน CDN อยู่แล้ว)
 *   5. แทรก desktop-bridge.js เพื่อเชื่อมเมนู/ไฟล์ของ Windows เข้ากับแอป
 *   6. เขียนผลลัพธ์ไปที่ app/ (โฟลเดอร์นี้สร้างใหม่ทุกครั้ง ห้ามแก้มือ)
 *
 * ไม่ได้แก้ไฟล์ใน web/ — ไฟล์ต้นฉบับยังเหมือนเดิมทุกตัวอักษร
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'app');
const NM = path.join(ROOT, 'node_modules');

function fail(msg) {
  console.error('\n✖ ' + msg + '\n');
  process.exit(1);
}

// ---------- 1) หาไฟล์ HTML ----------
const htmls = fs.existsSync(WEB) ? fs.readdirSync(WEB).filter(f => /\.html?$/i.test(f)) : [];
if (htmls.length === 0) fail('ไม่พบไฟล์ .html ในโฟลเดอร์ web/ — วางไฟล์โยธาแคดเวอร์ชันเว็บไว้ในโฟลเดอร์นี้');
if (htmls.length > 1) fail('โฟลเดอร์ web/ มีไฟล์ .html หลายไฟล์ (' + htmls.join(', ') + ') — ให้เหลือไว้ไฟล์เดียว');
const srcName = htmls[0];
let html = fs.readFileSync(path.join(WEB, srcName), 'utf8');
console.log('• ใช้ไฟล์ web/' + srcName + ' (' + Math.round(html.length / 1024) + ' KB)');

// อ่านเวอร์ชันของแอปเว็บ (เช่น v8.8) จากคอมเมนต์ "// ===== v8.8:" ที่มากที่สุด เพื่อแสดงในหน้าต่าง "เกี่ยวกับ"
let webVersion = '';
{
  const vs = [...html.matchAll(/\bv(\d+)\.(\d+)(?:\.(\d+))?\s*:/g)].map(m => [+m[1], +m[2], +(m[3] || 0)]);
  vs.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  if (vs.length) webVersion = 'v' + vs[0][0] + '.' + vs[0][1] + (vs[0][2] ? '.' + vs[0][2] : '');
}

// ---------- เตรียมโฟลเดอร์ app/ ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'vendor', 'fonts'), { recursive: true });

function copy(from, to) {
  if (!fs.existsSync(from)) fail('ไม่พบไฟล์ ' + path.relative(ROOT, from) + ' — รัน npm install ก่อน');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// ---------- 2) Three.js ----------
let threeCount = 0;
html = html.replace(/<script[^>]+src=["'][^"']*three(?:\.min)?\.js["'][^>]*><\/script>/gi, () => {
  threeCount++;
  return '<script src="vendor/three.min.js"></script>';
});
if (!threeCount) console.warn('⚠ ไม่พบแท็ก <script> ของ Three.js ใน HTML (ข้ามขั้นนี้)');
// เวอร์ชันเว็บอ้าง three r128 — ใช้แพ็กเกจ three@0.128.0 ซึ่งเป็นตัวเดียวกัน
copy(path.join(NM, 'three', 'build', 'three.min.js'), path.join(OUT, 'vendor', 'three.min.js'));
{
  const m = html.match(/three\.js\/r(\d+)\//);
  const pkg = require(path.join(NM, 'three', 'package.json')).version; // 0.128.0
  if (m && +m[1] !== +pkg.split('.')[1]) {
    console.warn('⚠ HTML ใช้ Three.js r' + m[1] + ' แต่แพ็กเกจในเครื่องเป็น r' + pkg.split('.')[1] +
      ' — แก้ "three" ใน package.json เป็น "0.' + m[1] + '.0" แล้วรัน npm install');
  }
}

// ---------- 3) ฟอนต์ ----------
// แปลงลิงก์ Google Fonts เป็น @font-face ในเครื่อง โดยใช้แพ็กเกจ @fontsource/*
const fontCss = [];
const missingFonts = [];
html = html.replace(/<link[^>]+href=["'](https:\/\/fonts\.googleapis\.com\/css2\?[^"']+)["'][^>]*>/gi, (tag, url) => {
  const u = new URL(url.replace(/&amp;/g, '&'));
  for (const fam of u.searchParams.getAll('family')) {
    const [name, spec] = fam.split(':');
    const family = name.replace(/\+/g, ' ');
    let weights = ['400'];
    const wm = spec && spec.match(/wght@([\d;.,]+)/);
    if (wm) weights = wm[1].split(/[;,]/).filter(Boolean);
    const pkg = family.toLowerCase().replace(/\s+/g, '-');
    const pkgDir = path.join(NM, '@fontsource', pkg);
    if (!fs.existsSync(pkgDir)) { missingFonts.push(family + ' (npm install -D @fontsource/' + pkg + ')'); continue; }
    for (const w of weights) {
      const cssFile = path.join(pkgDir, w + '.css');
      if (!fs.existsSync(cssFile)) { console.warn('⚠ ฟอนต์ ' + family + ' ไม่มีน้ำหนัก ' + w); continue; }
      let css = fs.readFileSync(cssFile, 'utf8');
      // ใช้เฉพาะ woff2 (Chromium รองรับครบ) และคัดลอกเฉพาะไฟล์ที่ใช้จริง
      css = css.replace(/src:\s*([^;]+);/g, (all, list) => {
        const w2 = list.match(/url\(\.\/files\/([^)]+\.woff2)\)/);
        if (!w2) return all;
        copy(path.join(pkgDir, 'files', w2[1]), path.join(OUT, 'vendor', 'fonts', pkg, w2[1]));
        return "src: url('" + pkg + '/' + w2[1] + "') format('woff2');";
      });
      fontCss.push(css);
    }
  }
  return '<link rel="stylesheet" href="vendor/fonts/fonts.css">';
});
// ลบ preconnect ไป Google (ไม่จำเป็นเมื่อออฟไลน์)
html = html.replace(/<link[^>]+rel=["']preconnect["'][^>]*>\s*/gi, '');
fs.writeFileSync(path.join(OUT, 'vendor', 'fonts', 'fonts.css'), fontCss.join('\n'));
if (missingFonts.length) console.warn('⚠ ยังไม่มีฟอนต์ในเครื่อง จะใช้ฟอนต์สำรองของ Windows แทน:\n   - ' + missingFonts.join('\n   - '));

// ---------- 4) ExcelJS ----------
// แอปเว็บพยายามโหลด 'exceljs.min.js' จากโฟลเดอร์เดียวกันก่อน แล้วจึงใช้ CDN
copy(path.join(NM, 'exceljs', 'dist', 'exceljs.min.js'), path.join(OUT, 'exceljs.min.js'));
// กันไว้กรณีเวอร์ชันใหม่โหลดจาก CDN ตรง ๆ: ชี้ URL ของ CDN มาที่ไฟล์ในเครื่อง
html = html.replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/exceljs@[^'"]+\/dist\/exceljs\.min\.js/g, 'exceljs.min.js');

// ---------- ลบ manifest/PWA (โปรแกรม Windows ไม่ต้องใช้) ----------
html = html.replace(/<link[^>]+rel=["']manifest["'][^>]*>\s*/gi, '');

// ---------- 5) desktop bridge ----------
const meta = '<meta name="yothacad-desktop" content="1">\n' +
  '<meta name="yothacad-web-version" content="' + webVersion + '">\n' +
  '<meta name="yothacad-web-source" content="' + srcName.replace(/"/g, '') + '">\n';
html = html.replace(/<head>/i, m => m + '\n' + meta);
if (/<\/body>/i.test(html)) html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="desktop-bridge.js"></script>\n</body>');
else html += '\n<script src="desktop-bridge.js"></script>\n';
copy(path.join(ROOT, 'src', 'renderer', 'desktop-bridge.js'), path.join(OUT, 'desktop-bridge.js'));

// ---------- ตรวจว่าไม่เหลือการพึ่งพาอินเทอร์เน็ตที่จำเป็น ----------
const leftovers = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);
if (leftovers.length) console.warn('⚠ ยังมีไฟล์ที่โหลดจากอินเทอร์เน็ต (จะใช้ไม่ได้ตอนออฟไลน์):\n   - ' + leftovers.join('\n   - '));

fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, 'build-info.json'), JSON.stringify({
  webSource: srcName, webVersion, preparedAt: new Date().toISOString()
}, null, 2));
console.log('✔ เตรียม app/ เสร็จ' + (webVersion ? ' (แอปเว็บ ' + webVersion + ')' : '') +
  ' — ฟอนต์ ' + fontCss.length + ' ชุด, Three.js ' + (threeCount ? 'ในเครื่อง' : '—'));
