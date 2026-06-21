const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Pino = require('pino');
const QRCode = require('qrcode');

const config = require('../config/config');
const Logger = require('../utils/logger');
const SessionManager = require('./session-manager');
const MessageHandler = require('../features/message-handler');
const AntiDeleteSystem = require('../features/anti-delete');
const StatusWatcher = require('../features/status-watcher');
const TelegramForwarder = require('../utils/telegram-forwarder');
const AntiDetect = require('../utils/anti-detect');

const logger = new Logger('WhatsApp');

class WhatsAppClient {
    constructor(io) {
        this.io = io;
        this.sock = null;
        this.connected = false;
        this.attempts = 0;
        this.lockReconnect = false;
        this.initializing = false;

        this.sessionManager = new SessionManager(config.auth.path);
        this.messageHandler = new MessageHandler();
        this.antiDelete = new AntiDeleteSystem(this.messageHandler);
        this.statusWatcher = new StatusWatcher(this);

        this.statusQueue = [];
        this.processing = false;
    }

    async initialize() {
        if (this.initializing) return;
        this.initializing = true;

        try {
            const { state, saveCreds } = await useMultiFileAuthState(config.auth.path);

            this.sock = makeWASocket({
                auth: state,
                logger: Pino({ level: 'silent' }),
                browser: ['Chrome', 'Linux', '1.0'],
                printQRInTerminal: false
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', (u) => this.handleConnection(u));

            this.sock.ev.on('messages.upsert', async (m) => {
                await this.messageHandler.handle(m);

                for (const msg of m.messages || []) {
                    this.queueStatus(msg);
                }
            });

            this.sock.ev.on('messages.update', (u) => {
                this.antiDelete.handle(u, this);
            });

        } finally {
            this.initializing = false;
        }
    }

    async handleConnection(update) {
        const { connection, lastDisconnect, qr } = update;

        // QR CODE
        if (qr) {
            const img = await QRCode.toDataURL(qr);
            if (this.io) this.io.emit('qr', img);
            logger.info('QR généré');
        }

        // CONNECTÉ
        if (connection === 'open') {
            this.connected = true;
            this.attempts = 0;
            this.lockReconnect = false;

            logger.success('WhatsApp connecté');

            await TelegramForwarder.notifyConnected();
            if (this.io) this.io.emit('connected');
        }

        // FERMÉ
        if (connection === 'close') {
            this.connected = false;

            const statusCode = lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output.statusCode
                : null;

            const errorMessage = lastDisconnect?.error?.message || lastDisconnect?.error;

            logger.error(`WhatsApp fermé | code=${statusCode}`);
            logger.error(`Cause: ${errorMessage}`);

            const shouldReconnect =
                statusCode !== DisconnectReason.loggedOut &&
                this.attempts < 5 &&
                !this.lockReconnect;

            // CLEAN SOCKET avant reconnect (IMPORTANT FIX)
            try {
                this.sock?.ev?.removeAllListeners?.();
                this.sock = null;
            } catch {}

            if (shouldReconnect) {
                this.attempts++;
                this.lockReconnect = true;

                const delay = 5000 * this.attempts;

                logger.warn(`Reconnexion dans ${delay / 1000}s`);

                setTimeout(() => {
                    this.lockReconnect = false;
                    this.initialize();
                }, delay);

            } else {
                logger.error('Reconnexion stoppée (loggedOut ou limite atteinte)');
            }
        }
    }

    queueStatus(msg) {
        if (msg.key.remoteJid !== 'status@broadcast') return;

        this.statusQueue.push(msg);

        if (!this.processing) this.processStatus();
    }

    async processStatus() {
        this.processing = true;

        while (this.statusQueue.length) {
            const msg = this.statusQueue.shift();
            await this.statusWatcher.handle(msg);
        }

        this.processing = false;
    }

    async sendMessage(jid, text) {
        if (!this.connected) return;

        if (!AntiDetect.canPerformAction()) return;

        await AntiDetect.beforeReply();

        return AntiDetect.simulateRealTyping(this.sock, jid, text);
    }

    async disconnect() {
        try {
            this.sock?.ev?.removeAllListeners?.();
            await this.sock?.logout?.();
        } catch {}
    }
}

module.exports = WhatsAppClient;
