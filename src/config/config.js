require('dotenv').config();

function toBool(value, fallback = false) {
    if (value === undefined) return fallback;
    return value === 'true';
}

function toInt(value, fallback) {
    const n = parseInt(value);
    return isNaN(n) ? fallback : n;
}

const config = {
    port: process.env.PORT || 3000,

    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || ''
    },

    auth: {
        path: process.env.AUTH_PATH || './auth'
    },

    limits: {
        maxDailyMessages: toInt(process.env.MAX_DAILY_MESSAGES, 100),
        nightMode: toBool(process.env.NIGHT_MODE, true)
    }
};

module.exports = config;
