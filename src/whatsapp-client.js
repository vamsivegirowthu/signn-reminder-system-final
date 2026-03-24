import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';

const SESSION_DIR = process.env.WA_SESSION_DIR || './wa-session';

class WhatsAppClient {
  constructor(logger) {
    this.sock = null;
    this.isConnected = false;
    this.logger = logger;
    this.qrCode = null;
    this.onQR = null;
    this.onReady = null;
    this.onDisconnect = null;
    this.messageQueue = [];
    this.processing = false;
  }

  async initialize() {
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const silentLogger = pino({ level: 'silent' });

    this.sock = makeWASocket({
      version,
      logger: silentLogger,
      auth: state,
      browser: ['Signn Reminder', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = qr;
        this.logger.info('📱 QR Code generated');
        if (this.onQR) this.onQR(qr);
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        this.isConnected = false;

        if (shouldReconnect) {
          setTimeout(() => this.initialize(), 5000);
        } else {
          if (this.onDisconnect) this.onDisconnect('logged_out');
        }
      } else if (connection === 'open') {
        this.isConnected = true;
        this.qrCode = null;
        this.logger.info('✅ WhatsApp connected!');
        if (this.onReady) this.onReady();
        this.processQueue();
      }
    });

    return this;
  }

  formatNumber(phone) {
    let number = phone.toString().replace(/\D/g, '');
    if (!number.startsWith('91') && number.length === 10) {
      number = '91' + number;
    }
    return `${number}@s.whatsapp.net`;
  }

  // 🔥 UPDATED FUNCTION (IMAGE + TEXT)
  async sendMessage(phone, message, retries = 3) {
    const jid = this.formatNumber(phone);
    const imagePath = './public/phani.jpg'; // 👈 image path

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (!this.isConnected) {
          throw new Error('WhatsApp not connected');
        }

        if (fs.existsSync(imagePath)) {
          const buffer = fs.readFileSync(imagePath);

          await this.sock.sendMessage(jid, {
            image: buffer,
            caption: message
          });

          this.logger.info(`📸 Image + message sent to ${phone}`);
        } else {
          await this.sock.sendMessage(jid, { text: message });
          this.logger.info(`✉️ Text message sent to ${phone}`);
        }

        return { success: true, phone, jid };

      } catch (err) {
        this.logger.warn(`Attempt ${attempt}/${retries} failed for ${phone}: ${err.message}`);
        if (attempt < retries) await delay(2000 * attempt);
      }
    }

    return { success: false, phone, error: 'Failed after retries' };
  }

  async sendBulkMessages(messages) {
    const results = [];
    for (const { phone, message } of messages) {
      const result = await this.sendMessage(phone, message);
      results.push(result);
      await delay(1500);
    }
    return results;
  }

  enqueueMessage(phone, message) {
    this.messageQueue.push({ phone, message });
    if (this.isConnected && !this.processing) {
      this.processQueue();
    }
  }

  async processQueue() {
    if (this.processing || this.messageQueue.length === 0) return;
    this.processing = true;

    while (this.messageQueue.length > 0) {
      const { phone, message } = this.messageQueue.shift();
      await this.sendMessage(phone, message);
      await delay(1200);
    }

    this.processing = false;
  }

  isReady() {
    return this.isConnected;
  }

  getQRCode() {
    return this.qrCode;
  }

  getStatus() {
    return {
      connected: this.isConnected,
      hasQR: !!this.qrCode,
      queueLength: this.messageQueue.length,
    };
  }

  async logout() {
    if (this.sock) {
      await this.sock.logout();
    }
  }
}

export default WhatsAppClient;