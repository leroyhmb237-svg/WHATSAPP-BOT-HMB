require('dotenv').config();

const fs = require('fs');
const path = require('path');

const config = require('./config/config');
const WhatsAppClient = require('./core/whatsapp-client');
const WebServer = require('./web/server');
const Logger = require('./utils/logger');

const logger = new Logger('Main');

async function main() {
    let server;
    let whatsapp;

    try {
        logger.info('🚀 Starting bot...');

        // 🔥 FIX 1: créer dossier auth AVANT tout
        const authPath = path.resolve(config.auth.path);

        if (!fs.existsSync(authPath)) {
            fs.mkdirSync(authPath, { recursive: true });
            logger.info(`📁 Auth folder created: ${authPath}`);
        }

        // 🔥 start server
        server = new WebServer();
        await server.start();

        // 🔥 start WhatsApp
        whatsapp = new WhatsAppClient(server.io);
        await whatsapp.initialize();

        // 🔥 Graceful shutdown
        const shutdown = async () => {
            logger.info('🛑 Shutting down...');

            try {
                if (whatsapp) await whatsapp.disconnect();
                if (server) await server.stop();
            } catch (e) {
                logger.error(`Shutdown error: ${e.message}`);
            }

            process.exit(0);
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

        // 🔥 crash protection
        process.on('uncaughtException', (err) => {
            logger.error(`Uncaught Exception: ${err.message}`);
        });

        process.on('unhandledRejection', (err) => {
            logger.error(`Unhandled Rejection: ${err?.message || err}`);
        });

    } catch (error) {
        logger.error(`Fatal error: ${error.message}`);
        process.exit(1);
    }
}

main();
