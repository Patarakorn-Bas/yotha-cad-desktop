// preload.js — สะพานที่ปลอดภัยระหว่างหน้าเว็บ (แอปเดิม) กับระบบไฟล์ของ Windows
// หน้าเว็บเห็นเฉพาะฟังก์ชันใน window.ycadDesktop ด้านล่าง ไม่มีสิทธิ์ใช้ Node.js โดยตรง
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ycadDesktop', {
  isDesktop: true,
  platform: process.platform,

  // เริ่มต้น: ถามโปรแกรมหลักว่าหน้าต่างนี้ต้องเปิดไฟล์อะไร
  ready: () => ipcRenderer.invoke('ycad:ready'),

  // บันทึกโครงการ (.ycad)
  saveProject: (opts) => ipcRenderer.invoke('ycad:save-project', opts),
  // เปิดไฟล์ด้วยหน้าต่างเลือกไฟล์ (.ycad / .json)
  openDialog: (opts) => ipcRenderer.invoke('ycad:open-dialog', opts),

  // ส่งออกไฟล์ (PDF/DXF/Excel/IFC/PNG/CSV…) — data เป็น Uint8Array หรือ string
  saveExport: (name, data) => ipcRenderer.invoke('ycad:save-export', { name, data }),
  showInFolder: (p) => ipcRenderer.invoke('ycad:show-in-folder', p),

  // แจ้งสถานะหน้าต่าง (ชื่อเรื่อง / มีงานยังไม่บันทึก / ไฟล์ที่ผูกอยู่)
  setState: (st) => ipcRenderer.send('ycad:state', st),

  // ถามยืนยันแบบกล่องข้อความของ Windows
  ask: (opts) => ipcRenderer.invoke('ycad:ask', opts),

  // รับคำสั่งจากเมนูของโปรแกรม
  onCommand: (fn) => ipcRenderer.on('ycad:cmd', (_e, msg) => fn(msg)),
  // ตอบกลับคำสั่งที่ต้องการผลลัพธ์ (เช่น บันทึกก่อนปิด)
  reply: (id, result) => ipcRenderer.send('ycad:reply', { id, result }),
});
