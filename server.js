const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');

const storage = require('./src/storage');
const WhatsAppManager = require('./src/whatsapp');
const CampaignEngine = require('./src/campaign');
const { BotService, calculateSpintaxVariations, generateSpintaxSamples } = require('./src/bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(storage.UPLOADS_DIR));

// File Upload Config (Max 25MB)
const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, storage.UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = `${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;
        cb(null, name);
    }
});
const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: 25 * 1024 * 1024 }
});

// Initialize Core Services
const whatsapp = new WhatsAppManager();
const bot = new BotService(whatsapp);
const campaignEngine = new CampaignEngine(whatsapp);

// Recover any interrupted campaigns from previous server runs
try {
    const allCamps = storage.getCampaigns();
    let hasRecovered = false;
    allCamps.forEach(c => {
        if (c.status === 'running') {
            c.status = 'stopped';
            c.interrupted = true;
            hasRecovered = true;
        }
    });
    if (hasRecovered) storage.saveCampaigns(allCamps);
} catch (e) {
    console.error('Campaign recovery check error:', e);
}

// Socket.io & Event Wiring
io.on('connection', (socket) => {
    // Send current status immediately on connection
    socket.emit('whatsapp:status', {
        status: whatsapp.connectionStatus,
        qrDataUrl: whatsapp.qrCodeDataUrl,
        user: whatsapp.userProfile
    });

    socket.emit('campaign:stats', campaignEngine.stats);

    socket.on('chat:mark_read', (jid) => {
        const updated = storage.markChatAsRead(jid);
        if (updated) {
            io.emit('chat:updated', updated);
        }
    });
});

// WhatsApp Events -> Socket.io Broadcasts
whatsapp.on('status_change', (data) => {
    io.emit('whatsapp:status', data);
});

whatsapp.on('qr', (data) => {
    io.emit('whatsapp:qr', data);
});

whatsapp.on('message', async (msg) => {
    io.emit('chat:message', msg);
    // Trigger Bot Auto-Reply check if not sent by us
    if (!msg.fromMe) {
        await bot.handleIncomingMessage(msg.jid, msg.text, msg, msg.senderName);
    }
});

whatsapp.on('message_sent', (msg) => {
    io.emit('chat:message', msg);
});

// Campaign Events -> Socket.io Broadcasts
campaignEngine.on('status_change', (stats) => {
    io.emit('campaign:stats', stats);
});

campaignEngine.on('log', (logEntry) => {
    io.emit('campaign:log', logEntry);
});

campaignEngine.on('batch_countdown', (data) => {
    io.emit('campaign:countdown', data);
});

// ==================== REST API ROUTES ==================== //

// 1. WhatsApp Status & Controls
app.get('/api/whatsapp/status', (req, res) => {
    res.json({
        status: whatsapp.connectionStatus,
        qrDataUrl: whatsapp.qrCodeDataUrl,
        user: whatsapp.userProfile
    });
});

app.post('/api/whatsapp/restart', async (req, res) => {
    await whatsapp.logout();
    res.json({ success: true, message: 'Restarting WhatsApp session...' });
});

// 2. Chat & Inbox
app.get('/api/chats', (req, res) => {
    const chats = storage.getChats();
    res.json(chats);
});

app.post('/api/chats/send', upload.single('media'), async (req, res) => {
    try {
        const { jid, text } = req.body;
        if (!jid) return res.status(400).json({ error: 'JID is required' });

        let mediaPath = null;
        if (req.file) {
            mediaPath = req.file.path;
        }

        const msg = await whatsapp.sendMessage(jid, text || '', mediaPath);
        res.json({ success: true, message: msg });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chats/update_contact', (req, res) => {
    try {
        const { jid, name, phone } = req.body;
        if (!jid) return res.status(400).json({ error: 'JID is required' });

        const chats = storage.getChats();
        if (chats[jid]) {
            if (name) chats[jid].name = name.trim();
            if (phone) chats[jid].phone = phone.replace(/[^0-9]/g, '');
            storage.saveChats(chats);
            io.emit('chat:updated', chats[jid]);
        }

        storage.addOrUpdateContact({
            jid,
            name: (name || '').trim(),
            phone: phone ? phone.replace(/[^0-9]/g, '') : (jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : ''),
            status: 'saved'
        });

        res.json({ success: true, chat: chats[jid] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/chats/:jid', (req, res) => {
    try {
        const jid = req.params.jid;
        const updatedChats = storage.deleteChat(jid);
        io.emit('chat:deleted', { jid });
        res.json({ success: true, chats: updatedChats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chats/clear_all', (req, res) => {
    try {
        storage.clearAllChats();
        io.emit('chat:cleared_all');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Contacts & Leads
app.get('/api/contacts', (req, res) => {
    res.json(storage.getContacts());
});

app.post('/api/contacts', (req, res) => {
    const contact = req.body;
    if (!contact.phone) return res.status(400).json({ error: 'Phone number is required' });
    const updated = storage.addOrUpdateContact(contact);
    res.json({ success: true, contacts: updated });
});

app.delete('/api/contacts/:phone', (req, res) => {
    const phone = req.params.phone;
    let contacts = storage.getContacts();
    contacts = contacts.filter(c => c.phone !== phone);
    storage.saveContacts(contacts);
    res.json({ success: true });
});

// 4. File Upload (CSV / Excel Contact Import)
app.post('/api/contacts/import', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const filePath = req.file.path;
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        const parsedContacts = [];
        for (const row of rows) {
            // Find phone field
            let phone = '';
            let name = '';

            for (const key of Object.keys(row)) {
                const lowerKey = key.toLowerCase();
                if (['phone', 'number', 'simu', 'namba', 'mobile', 'whatsapp', 'contact'].some(k => lowerKey.includes(k))) {
                    phone = row[key];
                }
                if (['name', 'jina', 'customer', 'mteja', 'client', 'first name'].some(k => lowerKey.includes(k))) {
                    name = row[key];
                }
            }

            // If phone wasn't found by header, pick first column with numbers
            if (!phone) {
                for (const key of Object.keys(row)) {
                    const val = String(row[key]);
                    if (val.replace(/[^0-9]/g, '').length >= 9) {
                        phone = val;
                        break;
                    }
                }
            }

            if (phone) {
                let cleanPhone = String(phone).replace(/[^0-9]/g, '');
                if (cleanPhone.startsWith('0') && cleanPhone.length === 10) {
                    cleanPhone = '255' + cleanPhone.substring(1);
                } else if (cleanPhone.length === 9 && (cleanPhone.startsWith('6') || cleanPhone.startsWith('7'))) {
                    cleanPhone = '255' + cleanPhone;
                }

                parsedContacts.push({
                    phone: cleanPhone,
                    name: name || 'Valued Client',
                    source: req.file.originalname,
                    customFields: row
                });
            }
        }

        // Clean up temp file
        fs.unlink(filePath, () => {});

        // Save into contact DB in a single atomic batch
        storage.bulkAddOrUpdateContacts(parsedContacts);

        res.json({
            success: true,
            totalImported: parsedContacts.length,
            contacts: parsedContacts
        });
    } catch (err) {
        console.error('Import error:', err);
        res.status(500).json({ error: 'Failed to parse file: ' + err.message });
    }
});

// 5. Campaigns
app.get('/api/campaigns', (req, res) => {
    res.json({
        campaigns: storage.getCampaigns(),
        activeStats: campaignEngine.stats
    });
});

app.post('/api/campaigns/spintax-preview', (req, res) => {
    try {
        const { messageTemplate, sampleData } = req.body;
        if (!messageTemplate) {
            return res.status(400).json({ error: 'Message template is required' });
        }
        const variationsCount = calculateSpintaxVariations(messageTemplate);
        const samples = generateSpintaxSamples(messageTemplate, 4, sampleData || {});
        res.json({
            success: true,
            variationsCount,
            samples
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/campaigns/start', upload.single('media'), (req, res) => {
    try {
        let { name, messageTemplate, recipients, minDelay, maxDelay, batchSize, batchPauseMinutes, overrideSafeHours } = req.body;

        if (typeof recipients === 'string') {
            recipients = JSON.parse(recipients);
        }

        if (!recipients || !recipients.length) {
            return res.status(400).json({ error: 'At least one recipient phone number is required' });
        }

        if (!messageTemplate) {
            return res.status(400).json({ error: 'Message template is required' });
        }

        let mediaUrl = null;
        if (req.file) {
            mediaUrl = req.file.path;
        }

        const campaign = campaignEngine.startCampaign({
            name: name || 'ELEVATESTORE Marketing Campaign',
            messageTemplate,
            recipients,
            mediaUrl,
            minDelay: Number(minDelay) || 15,
            maxDelay: Number(maxDelay) || 45,
            batchSize: Number(batchSize) || 20,
            batchPauseMinutes: Number(batchPauseMinutes) || 2,
            overrideSafeHours: overrideSafeHours === true || overrideSafeHours === 'true'
        });

        res.json({ success: true, campaign });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/campaigns/pause', (req, res) => {
    campaignEngine.pauseCampaign();
    res.json({ success: true, stats: campaignEngine.stats });
});

app.post('/api/campaigns/resume', (req, res) => {
    campaignEngine.resumeCampaign();
    res.json({ success: true, stats: campaignEngine.stats });
});

app.post('/api/campaigns/stop', (req, res) => {
    campaignEngine.stopCampaign();
    res.json({ success: true, stats: campaignEngine.stats });
});

// 6. Auto-Replies & Bot Rules
app.get('/api/autoreplies', (req, res) => {
    res.json(storage.getAutoReplies());
});

app.post('/api/autoreplies', (req, res) => {
    const rules = req.body;
    if (!Array.isArray(rules)) return res.status(400).json({ error: 'Rules must be an array' });
    storage.saveAutoReplies(rules);
    res.json({ success: true, rules });
});

// 7. Settings
app.get('/api/settings', (req, res) => {
    res.json(storage.getSettings());
});

app.post('/api/settings', (req, res) => {
    const settings = req.body;
    storage.saveSettings(settings);
    res.json({ success: true, settings });
});

// Start WhatsApp Client & Web Server
whatsapp.init();

server.listen(PORT, () => {
    console.log(`\n🚀 ELEVATESTORE WhatsApp Marketing & CRM Server running at http://localhost:${PORT}\n`);
});
