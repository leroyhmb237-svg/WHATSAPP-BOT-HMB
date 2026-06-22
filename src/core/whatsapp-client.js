const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const Pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');

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
            await this.cleanupSocket();

            if (!fs.existsSync(config.auth.path)) {
                fs.mkdirSync(config.auth.path, { recursive: true });
            }

            const { state, saveCreds } =
                await useMultiFileAuthState(config.auth.path);

            this.sock = makeWASocket({
                auth: state,
                logger: Pino({ level: 'debug' }),

                browser: ['Chrome', 'Chrome', '1.0.0'],
                markOnlineOnConnect: true,
                syncFullHistory: false,
                printQRInTerminal: false
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on(
                'connection.update',
                (update) => this.handleConnection(update)
            );

            this.sock.ev.on('messages.upsert', async (m) => {
                await this.messageHandler.handle(m);

                for (const msg of m.messages || []) {
                    this.queueStatus(msg);
                }
            });

            this.sock.ev.on('messages.update', (update) => {
                this.antiDelete.handle(update, this);
            });

        } catch (err) {
            logger.error(`Init error: ${err.message}`);
        } finally {
            this.initializing = false;
        }
    }

    async cleanupSocket() {
        try {
            if (this.sock) {
                this.sock.ev?.removeAllListeners?.();
                this.sock.ws?.close?.();
                this.sock = null;
            }
        } catch (e) {
            logger.error(`Cleanup error: ${e.message}`);
        }
    }

    async handleConnection(update) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const img = await QRCode.toDataURL(qr);

            this.io?.emit('qr', img);
            logger.info('QR généré');
        }

        if (connection === 'open') {
            this.connected = true;
            this.attempts = 0;
            this.lockReconnect = false;

            logger.success('WhatsApp connecté');

            await TelegramForwarder.notifyConnected();

            this.io?.emit('connected');
        }

        if (connection === 'close') {
            this.connected = false;

            const statusCode =
                lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output.statusCode
                    : lastDisconnect?.error?.output?.statusCode;

            const errorMessage =
                lastDisconnect?.error?.message ||
                String(lastDisconnect?.error);

            logger.error(`WhatsApp fermé | code=${statusCode}`);

            console.log('==========================');
            console.log('LAST DISCONNECT');
            console.dir(lastDisconnect, { depth: null });
            console.log('==========================');

            logger.error(`Cause: ${errorMessage}`);

            await this.cleanupSocket();

            const shouldReconnect =
                this.attempts < 10 &&
                !this.lockReconnect;

            if (!shouldReconnect) {
                logger.error(
                    'Reconnexion stoppée (loggedOut ou limite atteinte)'
                );
                return;
            }

            this.attempts++;
            this.lockReconnect = true;

            const delay = Math.min(
                30000,
                this.attempts * 5000
            );

            logger.warn(
                `Reconnexion dans ${delay / 1000}s`
            );

            setTimeout(() => {
                this.lockReconnect = false;
                this.initialize();
            }, delay);
        }
    }

    queueStatus(msg) {
        if (msg?.key?.remoteJid !== 'status@broadcast') {
            return;
        }

        this.statusQueue.push(msg);

        if (!this.processing) {
            this.processStatus();
        }
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
        if (!this.connected || !this.sock) {
            return;
        }

        if (!AntiDetect.canPerformAction()) {
            return;
        }

        await AntiDetect.beforeReply();

        return AntiDetect.simulateRealTyping(
            this.sock,
            jid,
            text
        );
    }

    async disconnect() {
        try {
            if (this.sock) {
                await this.sock.logout();
            }

            await this.cleanupSocket();
        } catch (e) {
            logger.error(`Disconnect error: ${e.message}`);
        }
    }
}

module.exports = WhatsAppClient;
