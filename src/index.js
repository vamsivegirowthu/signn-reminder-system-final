import 'dotenv/config';
import pino from 'pino';
import fs from 'fs';

import WhatsAppClient from './whatsapp-client.js';
import ScanTracker from './scan-tracker.js';
import ReminderScheduler from './scheduler.js';
import { createDashboardServer } from './dashboard-server.js';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
  level: 'info',
});

const CLINIC_FILE   = process.env.CLINIC_DATA_FILE || './data/clinics.json';
const SCHEDULE_FILE = './data/schedule.json';

if (!fs.existsSync(CLINIC_FILE))   { fs.writeFileSync(CLINIC_FILE,   '{"clinics":[]}'); }
if (!fs.existsSync(SCHEDULE_FILE)) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ reminders: [
    { id:'reminder-morning',    label:'Morning Reminder',  description:'Send readiness scan reminder to all staff',    type:'morning',    cron:'0 8 * * 1-6',  time:'08:00', days:['mon','tue','wed','thu','fri','sat'], enabled:true, emoji:'🌅' },
    { id:'reminder-followup',   label:'1-Hour Follow-up',  description:'Remind staff who have not scanned yet',        type:'followup',   cron:'0 9 * * 1-6',  time:'09:00', days:['mon','tue','wed','thu','fri','sat'], enabled:true, emoji:'⏰' },
    { id:'reminder-supervisor', label:'Supervisor Alert',  description:'Alert supervisor with non-compliant staff list',type:'supervisor', cron:'0 10 * * 1-6', time:'10:00', days:['mon','tue','wed','thu','fri','sat'], enabled:true, emoji:'🚨' },
  ]}, null, 2));
}

const clinicData = JSON.parse(fs.readFileSync(CLINIC_FILE, 'utf8'));
const scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
logger.info(`Loaded ${clinicData.clinics.length} clinics, ${clinicData.clinics.reduce((a,c)=>a+c.staff.length,0)} staff`);

const tracker = new ScanTracker(logger);
tracker.initializeClinics(clinicData.clinics);

const waClient = new WhatsAppClient(logger);

const tempScheduler = {
  wa: waClient,
  getStats: () => ({}),
  getActivityLog: () => [],
  sendMorningReminders:  async () => ({ error: 'Not ready' }),
  sendFollowupReminders: async () => ({ error: 'Not ready' }),
  sendSupervisorAlerts:  async () => ({ error: 'Not ready' }),
  rescheduleJobs: () => {},
  emitDashboardUpdate: () => {},
  io: null,
};

const PORT = parseInt(process.env.DASHBOARD_PORT || '3000');
const { httpServer, io } = createDashboardServer({ scheduler: tempScheduler, tracker, clinicData, logger });
httpServer.listen(PORT, () => logger.info(`🖥️  Dashboard → http://localhost:${PORT}`));

logger.info('🔐 Initializing WhatsApp...');
logger.info('📱 Open dashboard to scan QR code');

waClient.onQR = qr => io.emit('qr_update', { qr });

waClient.onReady = () => {
  io.emit('wa_connected', { time: new Date().toISOString() });

  const scheduler = new ReminderScheduler({ waClient, scanTracker: tracker, clinicData, logger, io });
  scheduler.io = io;

  // Hot-patch tempScheduler
  Object.assign(tempScheduler, {
    sendMorningReminders:  (...a) => scheduler.sendMorningReminders(...a),
    sendFollowupReminders: (...a) => scheduler.sendFollowupReminders(...a),
    sendSupervisorAlerts:  (...a) => scheduler.sendSupervisorAlerts(...a),
    rescheduleJobs:        (...a) => scheduler.rescheduleJobs(...a),
    getStats:              ()     => scheduler.getStats(),
    getActivityLog:        (...a) => scheduler.getActivityLog(...a),
    emitDashboardUpdate:   ()     => scheduler.emitDashboardUpdate(),
    wa: waClient,
    io,
  });
  tempScheduler.io = io;

  const reminders = JSON.parse(fs.readFileSync(SCHEDULE_FILE,'utf8')).reminders;
  scheduler.scheduleJobs(reminders);
  scheduler.emitDashboardUpdate();

  logger.info('');
  logger.info('═══════════════════════════════════════════════');
  logger.info('  ✅  Signn Reminder System is LIVE!');
  logger.info(`  🖥️   Dashboard: http://localhost:${PORT}`);
  logger.info(`  📅  ${reminders.filter(r=>r.enabled).length} reminder(s) scheduled`);
  logger.info('═══════════════════════════════════════════════');
};

waClient.onDisconnect = reason => {
  io.emit('wa_disconnected', { reason });
  logger.error('WhatsApp disconnected: ' + reason);
};

await waClient.initialize();

process.on('SIGINT', async () => {
  logger.info('\n🛑 Shutting down...');
  await waClient.logout().catch(()=>{});
  process.exit(0);
});
process.on('uncaughtException',  e => logger.error('Uncaught:', e));
process.on('unhandledRejection', e => logger.error('Unhandled:', e));
