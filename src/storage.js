const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function getFilePath(filename) {
    return path.join(DATA_DIR, filename);
}

function readJSON(filename, defaultValue = []) {
    const file = getFilePath(filename);
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
            return defaultValue;
        }
        const content = fs.readFileSync(file, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`Error reading ${filename}:`, err);
        return defaultValue;
    }
}

function writeJSON(filename, data) {
    const file = getFilePath(filename);
    const tempFile = `${file}.tmp_${Date.now()}`;
    try {
        fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tempFile, file);
        return true;
    } catch (err) {
        console.error(`Error writing ${filename}:`, err);
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch(e) {}
        return false;
    }
}

// Automatically resolve actual phone number from WhatsApp LID mapping
function resolvePhoneNumber(jid) {
    if (!jid) return '';
    if (jid.endsWith('@s.whatsapp.net')) {
        return jid.split('@')[0];
    }
    if (jid.endsWith('@lid')) {
        const lidNum = jid.split('@')[0];
        const reverseFile = path.join(SESSIONS_DIR, `lid-mapping-${lidNum}_reverse.json`);
        if (fs.existsSync(reverseFile)) {
            try {
                const phone = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
                if (phone) return String(phone).replace(/[^0-9]/g, '');
            } catch (e) {}
        }
        try {
            const files = fs.readdirSync(SESSIONS_DIR);
            for (const file of files) {
                if (file.startsWith('lid-mapping-') && !file.includes('_reverse')) {
                    const content = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8');
                    if (content.includes(lidNum)) {
                        const phone = file.replace('lid-mapping-', '').replace('.json', '');
                        return phone;
                    }
                }
            }
        } catch (e) {}
    }
    return '';
}

// Default English Auto-Reply Rules for ELEVATESTORE
const defaultAutoReplies = [
    {
        id: 'rule-welcome',
        name: 'Welcome Greeting',
        keywords: ['hello', 'hi', 'hey', 'start', 'good morning', 'good afternoon', 'info', 'habari', 'mambo'],
        matchType: 'contains',
        replyText: `Hello! 👋 Welcome to *ELEVATESTORE* — Your Destination for Premium Contemporary Fashion. ✨

How may we assist you today?
1️⃣ View *New Arrivals / Catalog* (Reply *CATALOG*)
2️⃣ Inquire about *Pricing & Sizing* (Reply *PRICE*)
3️⃣ *Store Location & Delivery* (Reply *LOCATION*)
4️⃣ Speak with a *Customer Stylist* (Reply *SUPPORT*)

We are dedicated to elevating your everyday style! 🛍️`,
        enabled: true,
        mediaUrl: null
    },
    {
        id: 'rule-location',
        name: 'Store Location & Delivery',
        keywords: ['location', 'where', 'address', 'store', 'shop', 'delivery', 'shipping'],
        matchType: 'contains',
        replyText: `📍 *ELEVATESTORE Boutique & Fulfillment:*

We offer express door-to-door delivery nationwide with full package tracking! 🚚

🕒 *Operating Hours:* Monday – Saturday (8:30 AM – 8:00 PM)
📞 *Direct Concierge:* +255 7XX XXX XXX

Would you like to schedule an order delivery or visit our showroom?`,
        enabled: true,
        mediaUrl: null
    },
    {
        id: 'rule-catalog',
        name: 'New Catalog & Collections',
        keywords: ['catalog', 'catalogue', 'collection', 'clothes', 'dresses', 'shirts', 'pants', 'suits', 'price', 'pricing'],
        matchType: 'contains',
        replyText: `✨ *ELEVATESTORE - Signature Collections:*

Discover our luxury curated selection:
👗 Haute Couture & Evening Dresses
👔 Tailored Shirts & Designer Tees
👖 Premium Denim & Trousers
👠 Footwear & Fashion Accessories

Our dedicated stylist will share our latest lookbook preview with you shortly! What style or size are you looking for? 👇`,
        enabled: true,
        mediaUrl: null
    },
    {
        id: 'rule-support',
        name: 'Live Stylist / Support',
        keywords: ['support', 'agent', 'human', 'help', 'representative', 'talk', 'call'],
        matchType: 'contains',
        replyText: `Please hold on for a moment, an *ELEVATESTORE Stylist* is connecting to assist you right now. 💬 Thank you for your patience!`,
        enabled: true,
        mediaUrl: null
    }
];

// Persistent storage manager
const storage = {
    DATA_DIR,
    UPLOADS_DIR,
    SESSIONS_DIR,

    // Settings
    getSettings() {
        const defaults = {
            storeName: 'ELEVATESTORE',
            phone: '',
            minDelaySeconds: 15,
            maxDelaySeconds: 45,
            batchSize: 20,
            batchPauseMinutes: 2,
            autoReplyEnabled: true,
            soundNotifications: true,
            // Anti-Ban Safeguards
            simulateTyping: true,
            typingSpeedCharsPerSec: 35,
            safeHoursEnabled: true,
            safeHoursStart: '08:00',
            safeHoursEnd: '21:00',
            safeHoursTimezone: 'local'
        };
        const saved = readJSON('settings.json', defaults);
        return { ...defaults, ...saved };
    },
    saveSettings(settings) {
        return writeJSON('settings.json', settings);
    },

    // Contacts
    getContacts() {
        const raw = readJSON('contacts.json', []);
        const ownPhones = ['255664994125', '1650056011888'];
        const validContacts = [];
        const seen = new Set();

        raw.forEach(c => {
            let phone = c.phone || '';
            if (phone.includes('@lid')) {
                const resolved = resolvePhoneNumber(c.jid || phone);
                if (resolved) phone = resolved;
                else return;
            }
            phone = String(phone).replace(/[^0-9]/g, '');
            if (!phone || phone.length < 9) return;
            if (ownPhones.includes(phone) || (c.name && c.name.toLowerCase() === 'elevatestore' && phone.length > 12)) return;

            if (!seen.has(phone)) {
                seen.add(phone);
                validContacts.push({
                    ...c,
                    phone
                });
            }
        });

        return validContacts;
    },
    saveContacts(contacts) {
        return writeJSON('contacts.json', contacts);
    },
    addOrUpdateContact(contact) {
        const contacts = this.getContacts();
        const index = contacts.findIndex(c => c.phone === contact.phone);
        const now = new Date().toISOString();
        if (index >= 0) {
            contacts[index] = { ...contacts[index], ...contact, updatedAt: now };
        } else {
            contacts.unshift({ ...contact, createdAt: now, updatedAt: now });
        }
        this.saveContacts(contacts);
        return contacts;
    },
    bulkAddOrUpdateContacts(newContactsList) {
        const contacts = this.getContacts();
        const map = new Map();
        contacts.forEach(c => map.set(c.phone, c));
        const now = new Date().toISOString();

        newContactsList.forEach(c => {
            if (!c.phone) return;
            const existing = map.get(c.phone);
            if (existing) {
                map.set(c.phone, { ...existing, ...c, updatedAt: now });
            } else {
                map.set(c.phone, { ...c, createdAt: now, updatedAt: now });
            }
        });

        const merged = Array.from(map.values());
        this.saveContacts(merged);
        return merged;
    },

    // Auto-Replies
    getAutoReplies() {
        return readJSON('autoreplies.json', defaultAutoReplies);
    },
    saveAutoReplies(rules) {
        return writeJSON('autoreplies.json', rules);
    },

    // Campaigns
    getCampaigns() {
        return readJSON('campaigns.json', []);
    },
    saveCampaigns(campaigns) {
        return writeJSON('campaigns.json', campaigns);
    },
    addCampaign(campaign) {
        const campaigns = this.getCampaigns();
        campaigns.unshift(campaign);
        this.saveCampaigns(campaigns);
        return campaign;
    },
    updateCampaign(id, updates) {
        const campaigns = this.getCampaigns();
        const idx = campaigns.findIndex(c => c.id === id);
        if (idx >= 0) {
            campaigns[idx] = { ...campaigns[idx], ...updates, updatedAt: new Date().toISOString() };
            this.saveCampaigns(campaigns);
            return campaigns[idx];
        }
        return null;
    },

    // Chats & Messages
    getChats() {
        const rawChats = readJSON('chats.json', {});
        const cleanChats = {};
        const ownPhones = ['255664994125', '1650056011888'];

        for (const [jid, chat] of Object.entries(rawChats)) {
            if (jid === 'status@broadcast' || jid === '1650056011888@lid') continue;

            if (!chat.phone || chat.phone.includes('@lid')) {
                const resolved = resolvePhoneNumber(jid);
                if (resolved) chat.phone = resolved;
                else if (jid.endsWith('@s.whatsapp.net')) chat.phone = jid.split('@')[0];
            }

            if (chat.phone) {
                const cleanNum = String(chat.phone).replace(/[^0-9]/g, '');
                if (ownPhones.includes(cleanNum) && (!chat.messages || chat.messages.every(m => m.fromMe))) {
                    continue; // Skip self chats
                }
                chat.phone = cleanNum;
            }

            cleanChats[jid] = chat;
        }

        return cleanChats;
    },
    resolvePhoneNumber,
    saveChats(chats) {
        return writeJSON('chats.json', chats);
    },
    addMessageToChat(jid, message) {
        const chats = this.getChats();
        if (!chats[jid]) {
            chats[jid] = {
                jid,
                name: message.senderName || jid.split('@')[0],
                unreadCount: 0,
                lastMessage: message.text || (message.hasMedia ? '[Media Attachment]' : ''),
                lastTimestamp: message.timestamp || Date.now(),
                messages: []
            };
        }
        // Don't overwrite chat name with own profile name when sending a message
        if (!message.fromMe && message.senderName && message.senderName !== 'You') {
            chats[jid].name = message.senderName;
        }

        // If phone or contact name is known from contacts DB, prefer it
        const contacts = this.getContacts();
        const contactMatch = contacts.find(c => c.jid === jid || (c.phone && jid.startsWith(c.phone)));
        if (contactMatch && contactMatch.name) {
            chats[jid].name = contactMatch.name;
            if (contactMatch.phone) chats[jid].phone = contactMatch.phone;
        }

        if (message.fromMe) {
            chats[jid].unreadCount = 0;
        } else {
            chats[jid].unreadCount = (chats[jid].unreadCount || 0) + 1;
        }

        chats[jid].messages.push(message);
        if (chats[jid].messages.length > 200) {
            chats[jid].messages.shift();
        }

        this.saveChats(chats);
        return chats[jid];
    },
    deleteChat(jid) {
        const chats = this.getChats();
        if (chats[jid]) {
            delete chats[jid];
            this.saveChats(chats);
        }
        return chats;
    },
    clearAllChats() {
        this.saveChats({});
        return {};
    },
    markChatAsRead(jid) {
        const chats = this.getChats();
        if (chats[jid]) {
            chats[jid].unreadCount = 0;
            this.saveChats(chats);
            return chats[jid];
        }
        return null;
    }
};

module.exports = storage;
