const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const storage = require('./storage');

class WhatsAppManager extends EventEmitter {
    constructor() {
        super();
        this.sock = null;
        this.qrCodeDataUrl = null;
        this.connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'qr_ready', 'connected'
        this.userProfile = null;
        this.sessionDir = storage.SESSIONS_DIR;
    }

    async init() {
        try {
            this.connectionStatus = 'connecting';
            this.emit('status_change', { status: this.connectionStatus });

            const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
            const { version, isLatest } = await fetchLatestBaileysVersion();

            const logger = pino({ level: 'silent' });

            this.sock = makeWASocket({
                version,
                logger,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger)
                },
                generateHighQualityLinkPreview: true,
                syncFullHistory: false
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    try {
                        this.qrCodeDataUrl = await QRCode.toDataURL(qr);
                        this.connectionStatus = 'qr_ready';
                        this.emit('qr', { qrDataUrl: this.qrCodeDataUrl });
                        this.emit('status_change', { status: this.connectionStatus, qrDataUrl: this.qrCodeDataUrl });
                    } catch (err) {
                        console.error('QR code generation error:', err);
                    }
                }

                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    this.connectionStatus = 'disconnected';
                    this.qrCodeDataUrl = null;
                    this.userProfile = null;
                    this.emit('status_change', { status: 'disconnected', reason: lastDisconnect?.error?.message });

                    if (shouldReconnect) {
                        console.log('Reconnecting to WhatsApp...');
                        setTimeout(() => this.init(), 4000);
                    } else {
                        console.log('Logged out of WhatsApp. Clearing session and regenerating QR...');
                        this.clearSession();
                        setTimeout(() => this.init(), 2500);
                    }
                } else if (connection === 'open') {
                    this.connectionStatus = 'connected';
                    this.qrCodeDataUrl = null;
                    const user = this.sock.user;
                    this.userProfile = {
                        id: user?.id,
                        name: user?.name || 'ELEVATESTORE Owner',
                        phone: user?.id?.split(':')[0] || user?.id?.split('@')[0]
                    };
                    this.emit('status_change', {
                        status: 'connected',
                        user: this.userProfile
                    });
                    console.log('WhatsApp connected successfully as:', this.userProfile);
                }
            });

            // Phone Address Book Contacts Sync
            this.contactsStore = new Map();

            this.sock.ev.on('contacts.upsert', (contacts) => {
                for (const c of contacts) {
                    if (!c.id) continue;
                    this.contactsStore.set(c.id, c);
                    const name = c.name || c.notify || c.verifiedName;
                    if (name) {
                        const phone = c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : '';
                        storage.addOrUpdateContact({
                            jid: c.id,
                            phone: phone || c.id,
                            name: name,
                            source: 'Phone Sync'
                        });
                    }
                }
            });

            this.sock.ev.on('contacts.update', (updates) => {
                for (const u of updates) {
                    if (!u.id) continue;
                    const prev = this.contactsStore.get(u.id) || {};
                    const merged = { ...prev, ...u };
                    this.contactsStore.set(u.id, merged);
                    const name = merged.name || merged.notify || merged.verifiedName;
                    if (name) {
                        const phone = u.id.endsWith('@s.whatsapp.net') ? u.id.split('@')[0] : '';
                        storage.addOrUpdateContact({
                            jid: u.id,
                            phone: phone || u.id,
                            name: name,
                            source: 'Phone Sync'
                        });
                    }
                }
            });

            // Incoming messages listener
            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;

                for (const msg of messages) {
                    try {
                        if (!msg.message) continue;
                        const jid = msg.key.remoteJid;
                        const fromMe = msg.key.fromMe;
                        const isLid = jid.endsWith('@lid');

                        // Check if we have contact in memory or storage
                        let contactName = '';
                        let cleanPhone = storage.resolvePhoneNumber(jid) || (isLid ? '' : jid.split('@')[0]);

                        const fromStore = this.contactsStore.get(jid);
                        if (fromStore?.name || fromStore?.notify || fromStore?.verifiedName) {
                            contactName = fromStore.name || fromStore.notify || fromStore.verifiedName;
                        }

                        // Also check stored contacts in JSON
                        const savedContacts = storage.getContacts();
                        const found = savedContacts.find(c => c.jid === jid || (c.phone && cleanPhone && c.phone === cleanPhone));
                        if (found) {
                            if (found.name) contactName = found.name;
                            if (found.phone) cleanPhone = found.phone;
                        }

                        // Fallback to WhatsApp profile pushName if not fromMe
                        if (!contactName && !fromMe) {
                            contactName = msg.pushName || '';
                        }

                        const senderName = fromMe ? 'You' : (contactName || (cleanPhone ? `+${cleanPhone}` : 'WhatsApp Contact'));

                        // Extract text
                        let text = '';
                        let hasMedia = false;
                        let mediaType = null;

                        if (msg.message.conversation) {
                            text = msg.message.conversation;
                        } else if (msg.message.extendedTextMessage?.text) {
                            text = msg.message.extendedTextMessage.text;
                        } else if (msg.message.imageMessage) {
                            hasMedia = true;
                            mediaType = 'image';
                            text = msg.message.imageMessage.caption || '';
                        } else if (msg.message.videoMessage) {
                            hasMedia = true;
                            mediaType = 'video';
                            text = msg.message.videoMessage.caption || '';
                        } else if (msg.message.documentMessage) {
                            hasMedia = true;
                            mediaType = 'document';
                            text = msg.message.documentMessage.fileName || '';
                        }

                        const messageRecord = {
                            id: msg.key.id,
                            jid,
                            phone: cleanPhone,
                            senderName,
                            text,
                            fromMe,
                            hasMedia,
                            mediaType,
                            timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
                        };

                        // Store in chat records
                        storage.addMessageToChat(jid, messageRecord);

                        // If from a client, update contact record
                        if (!fromMe && !jid.endsWith('@g.us')) {
                            storage.addOrUpdateContact({
                                phone: cleanPhone,
                                name: senderName,
                                lastMessage: text,
                                status: 'replied'
                            });
                        }

                        this.emit('message', messageRecord);

                    } catch (err) {
                        console.error('Error processing incoming message:', err);
                    }
                }
            });

        } catch (error) {
            console.error('Failed to initialize Baileys:', error);
            this.connectionStatus = 'disconnected';
            this.emit('status_change', { status: 'disconnected', error: error.message });
        }
    }

    async sendMessage(jid, text, mediaPath = null) {
        if (!this.sock || this.connectionStatus !== 'connected') {
            throw new Error('WhatsApp is not connected! Please scan QR code first.');
        }

        let sentMsg;
        if (mediaPath && fs.existsSync(mediaPath)) {
            const ext = path.extname(mediaPath).toLowerCase();
            const buffer = fs.readFileSync(mediaPath);

            if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
                sentMsg = await this.sock.sendMessage(jid, {
                    image: buffer,
                    caption: text
                });
            } else if (['.mp4', '.mov'].includes(ext)) {
                sentMsg = await this.sock.sendMessage(jid, {
                    video: buffer,
                    caption: text
                });
            } else {
                sentMsg = await this.sock.sendMessage(jid, {
                    document: buffer,
                    mimetype: 'application/octet-stream',
                    fileName: path.basename(mediaPath),
                    caption: text
                });
            }
        } else {
            sentMsg = await this.sock.sendMessage(jid, { text });
        }

        const cleanPhone = jid.split('@')[0];
        const record = {
            id: sentMsg?.key?.id || Date.now().toString(),
            jid,
            phone: cleanPhone,
            senderName: 'You (ELEVATESTORE)',
            text,
            fromMe: true,
            hasMedia: !!mediaPath,
            timestamp: Date.now()
        };

        storage.addMessageToChat(jid, record);
        this.emit('message_sent', record);

        return record;
    }

    async sendPresence(jid, presence = 'composing') {
        try {
            if (this.sock && this.connectionStatus === 'connected') {
                await this.sock.sendPresenceUpdate(presence, jid);
            }
        } catch (e) {
            // Non-critical
        }
    }

    async simulateTyping(jid, textOrDuration = 2500) {
        if (!this.sock || this.connectionStatus !== 'connected') return;
        try {
            let durationMs = 2500;
            if (typeof textOrDuration === 'number') {
                durationMs = textOrDuration;
            } else if (typeof textOrDuration === 'string') {
                const settings = storage.getSettings();
                const charsPerSec = Number(settings.typingSpeedCharsPerSec) || 35;
                const calculated = (textOrDuration.length / charsPerSec) * 1000;
                const jitter = (Math.random() * 0.4 - 0.2) * calculated;
                durationMs = Math.max(1200, Math.min(6000, Math.round(calculated + jitter)));
            }

            await this.sock.sendPresenceUpdate('available');
            await this.sock.sendPresenceUpdate('composing', jid);
            await delay(durationMs);
            await this.sock.sendPresenceUpdate('paused', jid);
        } catch (e) {
            // Non-critical presence handling
        }
    }

    async checkOnWhatsApp(phone) {
        if (!this.sock || this.connectionStatus !== 'connected') return null;
        try {
            const clean = String(phone).replace(/[^0-9]/g, '');
            const result = await this.sock.onWhatsApp(`${clean}@s.whatsapp.net`);
            return result && result[0] ? result[0].exists : null;
        } catch (e) {
            return null;
        }
    }

    async logout() {
        try {
            if (this.sock) {
                await this.sock.logout();
            }
        } catch (e) {
            console.log('Error during logout:', e);
        }
        this.clearSession();
        this.connectionStatus = 'disconnected';
        this.qrCodeDataUrl = null;
        this.userProfile = null;
        this.emit('status_change', { status: 'disconnected' });
        setTimeout(() => this.init(), 1500);
    }

    clearSession() {
        try {
            if (fs.existsSync(this.sessionDir)) {
                fs.rmSync(this.sessionDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.error('Error clearing session dir:', e);
        }
    }
}

module.exports = WhatsAppManager;
