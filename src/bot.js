const storage = require('./storage');

function parseSpintax(text) {
    if (!text) return '';
    let result = String(text);
    const spintaxRegex = /\{([^{}]+)\}/g;
    let iterations = 0;
    while (spintaxRegex.test(result) && iterations < 15) {
        result = result.replace(spintaxRegex, (match, choices) => {
            const options = choices.split('|');
            const picked = options[Math.floor(Math.random() * options.length)];
            return picked !== undefined ? picked.trim() : '';
        });
        iterations++;
    }
    return result;
}

function calculateSpintaxVariations(text) {
    if (!text) return 1;
    let temp = String(text);
    const spintaxRegex = /\{([^{}]+)\}/g;
    let totalCombinations = 1;
    let iterations = 0;
    
    while (spintaxRegex.test(temp) && iterations < 15) {
        temp = temp.replace(spintaxRegex, (match, choices) => {
            const count = choices.split('|').length;
            totalCombinations *= Math.max(1, count);
            return '__VAR__';
        });
        iterations++;
    }
    return Math.max(1, totalCombinations);
}

function replaceVariables(text, data = {}) {
    if (!text) return '';
    let result = String(text);
    for (const [key, val] of Object.entries(data)) {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
        result = result.replace(regex, val !== undefined && val !== null ? String(val) : '');
    }
    return parseSpintax(result);
}

function generateSpintaxSamples(text, count = 3, sampleData = {}) {
    const defaultData = {
        name: 'Sarah',
        phone: '255712345678',
        store_name: storage.getSettings().storeName || 'ELEVATESTORE',
        ...sampleData
    };
    const samples = new Set();
    const maxAttempts = count * 10;
    for (let i = 0; i < maxAttempts && samples.size < count; i++) {
        samples.add(replaceVariables(text, defaultData));
    }
    return Array.from(samples);
}

class BotService {
    constructor(whatsappClient) {
        this.client = whatsappClient;
        // Cooldown cache: Map of `${jid}_${ruleId}` -> timestamp
        this.cooldowns = new Map();
        this.COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes cooldown per rule per user
    }

    async handleIncomingMessage(jid, text, messageObj, senderName) {
        const settings = storage.getSettings();
        if (!settings.autoReplyEnabled) return false;

        // Skip status broadcasts or group chats
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') return false;

        const cleanText = (text || '').trim().toLowerCase();
        if (!cleanText) return false;

        const cleanPhone = jid.split('@')[0];

        // 1. Opt-out (STOP / ACHA / SITAKI / UNSUBSCRIBE) Keyword Handler
        const optOutKeywords = ['stop', 'acha', 'sitaki', 'unsubscribe', 'ondoa'];
        const isOptOut = optOutKeywords.some(kw => {
            const regex = new RegExp(`\\b${kw}\\b`, 'i');
            return regex.test(cleanText);
        });

        if (isOptOut) {
            storage.addOrUpdateContact({
                phone: cleanPhone,
                name: senderName || 'Valued Client',
                optedOut: true,
                status: 'opted_out',
                lastMessage: text
            });

            setTimeout(async () => {
                try {
                    await this.client.sendMessage(
                        jid,
                        `Habari ${senderName || ''}. Umefanikiwa kujitoa kwenye orodha ya matangazo ya *${settings.storeName || 'ELEVATESTORE'}*. Hマトapokea ujumbe wa matangazo tena. Kama unahitaji msaada wowote, tupo hapa kukuhudumia! 🙏`
                    );
                } catch (e) {
                    console.error('Error sending opt-out confirmation:', e);
                }
            }, 1500);
            return true;
        }

        // 2. Regular Keyword Rules
        const rules = storage.getAutoReplies().filter(r => r.enabled);
        const now = Date.now();

        for (const rule of rules) {
            const cooldownKey = `${jid}_${rule.id}`;
            const lastTrigger = this.cooldowns.get(cooldownKey) || 0;

            // Check cooldown
            if (now - lastTrigger < this.COOLDOWN_MS) {
                continue;
            }

            let matched = false;
            if (rule.matchType === 'exact') {
                matched = rule.keywords.some(k => k.trim().toLowerCase() === cleanText);
            } else {
                // Word boundary search to prevent false triggers (e.g. "hi" inside "this")
                matched = rule.keywords.some(k => {
                    const kw = k.trim().toLowerCase();
                    if (!kw) return false;
                    // Escape special regex chars
                    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const wordBoundaryRegex = new RegExp(`(^|\\s|[.,!?;])${escaped}($|\\s|[.,!?;])`, 'i');
                    return wordBoundaryRegex.test(cleanText);
                });
            }

            if (matched) {
                this.cooldowns.set(cooldownKey, now);

                // Prepare reply text with spintax & variable replacement
                const replyText = replaceVariables(rule.replyText, {
                    name: senderName || 'Mteja Wetu',
                    store_name: settings.storeName || 'ELEVATESTORE',
                    phone: cleanPhone
                });

                // Simulate human typing presence & natural delay
                setTimeout(async () => {
                    try {
                        if (this.client.sendPresence) {
                            await this.client.sendPresence(jid, 'composing');
                        }
                        setTimeout(async () => {
                            await this.client.sendMessage(jid, replyText, rule.mediaUrl);
                        }, 1800);
                    } catch (err) {
                        console.error('Error sending auto-reply:', err);
                    }
                }, 1000);

                return true;
            }
        }

        return false;
    }
}

module.exports = {
    BotService,
    parseSpintax,
    calculateSpintaxVariations,
    generateSpintaxSamples,
    replaceVariables
};
