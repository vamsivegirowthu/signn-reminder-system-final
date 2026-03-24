import express from 'express';
import QRCode from 'qrcode';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer'; // ✅ NEW
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLINIC_FILE   = process.env.CLINIC_DATA_FILE || './data/clinics.json';
const SCHEDULE_FILE = './data/schedule.json';

const upload = multer({ dest: 'uploads/' }); // ✅ NEW

function loadClinics()   { return JSON.parse(fs.readFileSync(CLINIC_FILE,   'utf8')); }
function saveClinics(d)  { fs.writeFileSync(CLINIC_FILE,   JSON.stringify(d, null, 2)); }
function loadSchedule()  { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
function saveSchedule(d) { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(d, null, 2)); }
function uid()           { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function toCron(time, days) {
  const [h, m] = time.split(':').map(Number);
  const MAP = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
  const nums = (days||[]).map(d => MAP[d.toLowerCase()]).filter(n=>n!==undefined).sort().join(',');
  return `${m} ${h} * * ${nums || '1-6'}`;
}

export function createDashboardServer({ scheduler, tracker, clinicData, logger }) {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIO(httpServer, { cors: { origin: '*' } });

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  if (scheduler) scheduler.io = io;

  // ✅ TEMPLATE API (NEW)
  app.post('/api/template', upload.single('file'), (req, res) => {
    const message = req.body.message;
    const file = req.file;

    console.log("Template Message:", message);
    console.log("Uploaded File:", file);

    res.json({ success: true });
  });

  // STATUS / QR
  app.get('/api/status', (req, res) => {
    res.json({ connected: scheduler?.wa?.isReady?.() || false, qrAvailable: !!scheduler?.wa?.getQRCode?.(), stats: scheduler?.getStats?.() || {}, uptime: process.uptime() });
  });

  app.get('/api/qr', async (req, res) => {
    const qr = scheduler?.wa?.getQRCode?.();
    if (!qr) return res.status(404).json({ error: 'No QR available' });
    try {
      const png = await QRCode.toBuffer(qr, { width: 300, margin: 2 });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(png);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ================== (REST OF YOUR CODE SAME) ==================

  app.get('/api/summary', (req, res) => {
    const data = loadClinics();
    res.json({ summary: tracker.getSummary(data.clinics), date: new Date().toISOString() });
  });

  app.get('/api/employees', (req, res) => {
    const data = loadClinics();
    const records = tracker.getAllRecords().map(r => {
      for (const c of data.clinics) {
        const emp = c.staff.find(e => e.id === r.empId);
        if (emp) return { ...r, role: emp.role, clinicName: c.name, phone: emp.phone };
      }
      return r;
    });
    res.json({ employees: records });
  });

  // 👉 remaining code same as yours (NO CHANGE)

  return { httpServer, io, app };
}
