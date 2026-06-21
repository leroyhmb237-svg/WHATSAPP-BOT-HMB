if (connection === 'close') {
    this.connected = false;

    const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : lastDisconnect?.error?.output?.statusCode;

    const errorMessage = lastDisconnect?.error?.message || lastDisconnect?.error;

    logger.error(`WhatsApp fermé | code=${statusCode}`);
    logger.error(`Cause: ${errorMessage}`);

    const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        this.attempts < 5 &&
        !this.lockReconnect;

    // 🔥 CLEAN PROPRE SOCKET (IMPORTANT FIX STABLE)
    try {
        if (this.sock) {
            this.sock.ev.removeAllListeners();

            // fermeture websocket propre
            this.sock.ws?.close?.();
            this.sock = null;
        }
    } catch (e) {
        logger.error(`Cleanup error: ${e.message}`);
    }

    if (shouldReconnect) {
        this.attempts++;
        this.lockReconnect = true;

        const delay = Math.min(30000, 5000 * this.attempts);

        logger.warn(`Reconnexion dans ${delay / 1000}s`);

        setTimeout(() => {
            this.lockReconnect = false;
            this.initialize();
        }, delay);

    } else {
        logger.error('Reconnexion stoppée (loggedOut ou limite atteinte)');
    }
}
