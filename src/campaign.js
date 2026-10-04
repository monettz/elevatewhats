const { EventEmitter } = require('events');
const storage = require('./storage');
const { replaceVariables } = require('./bot');

class CampaignEngine extends EventEmitter {
    constructor(whatsappClient) {
        super();
        this.client = whatsappClient;
        this.activeCampaign = null;
        this.isPaused = false;
        this.isCancelled = false;
        this.queue = [];
        this.currentIndex = 0;
        this.delayTimeout = null;
        this.batchInterval = null;
        this.stats = {
            total: 0,
            sent: 0,
            failed: 0,
            status: 'idle' // 'idle', 'running', 'paused', 'completed', 'stopped'
        };
    }

    isWithinSafeHours(settings) {
        if (!settings || !settings.safeHoursEnabled) return true;
        const now = new Date();
        const currentMins = now.getHours() * 60 + now.getMinutes();

        const [startH, startM] = (settings.safeHoursStart || '08:00').split(':').map(Number);
        const [endH, endM] = (settings.safeHoursEnd || '21:00').split(':').map(Number);

        const startTotalMins = (isNaN(startH) ? 8 : startH) * 60 + (isNaN(startM) ? 0 : startM);
        const endTotalMins = (isNaN(endH) ? 21 : endH) * 60 + (isNaN(endM) ? 0 : endM);

        if (startTotalMins <= endTotalMins) {
            return currentMins >= startTotalMins && currentMins <= endTotalMins;
        } else {
            // Span across midnight
            return currentMins >= startTotalMins || currentMins <= endTotalMins;
        }
    }

    getSafeHoursResumeDetails(settings) {
        const now = new Date();
        const [startH, startM] = (settings.safeHoursStart || '08:00').split(':').map(Number);
        const nextStart = new Date(now.getTime());
        nextStart.setHours(isNaN(startH) ? 8 : startH, isNaN(startM) ? 0 : startM, 0, 0);

        if (nextStart.getTime() <= now.getTime()) {
            nextStart.setDate(nextStart.getDate() + 1);
        }

        const delayMs = Math.max(1000, nextStart.getTime() - now.getTime());
        const resumeTimeStr = nextStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return { delayMs, resumeTimeStr, nextStart };
    }

    startCampaign(campaignConfig) {
        if (this.stats.status === 'running' || this.stats.status === 'safe_hours_hold') {
            throw new Error('A campaign is already actively running!');
        }

        // Clean up any dangling timers
        this.clearTimers();

        const settings = storage.getSettings();
        const minDelay = campaignConfig.minDelay || settings.minDelaySeconds || 15;
        const maxDelay = campaignConfig.maxDelay || settings.maxDelaySeconds || 45;
        const batchSize = campaignConfig.batchSize || settings.batchSize || 20;
        const batchPause = campaignConfig.batchPauseMinutes || settings.batchPauseMinutes || 2;
        const overrideSafeHours = !!campaignConfig.overrideSafeHours;

        // 1. Deduplicate recipients & filter opted-out contacts
        const savedContacts = storage.getContacts();
        const optedOutSet = new Set(
            savedContacts.filter(c => c.optedOut).map(c => String(c.phone).replace(/[^0-9]/g, ''))
        );

        const seenPhones = new Set();
        const cleanRecipients = [];

        (campaignConfig.recipients || []).forEach(r => {
            let raw = r.phone || r.number || '';
            let clean = String(raw).replace(/[^0-9]/g, '');

            if (clean.startsWith('0') && clean.length === 10) {
                clean = '255' + clean.substring(1);
            } else if (clean.length === 9 && (clean.startsWith('6') || clean.startsWith('7'))) {
                clean = '255' + clean;
            }

            if (!clean || clean.length < 9) return;
            if (optedOutSet.has(clean)) return; // Skip opted out
            if (seenPhones.has(clean)) return;  // Deduplicate

            seenPhones.add(clean);
            cleanRecipients.push({
                ...r,
                phone: clean,
                name: r.name || 'Valued Client'
            });
        });

        if (cleanRecipients.length === 0) {
            throw new Error('No valid, active recipients found after filtering duplicates and opted-out contacts.');
        }

        this.activeCampaign = {
            id: 'camp_' + Date.now(),
            name: campaignConfig.name || 'ELEVATESTORE Marketing Campaign',
            messageTemplate: campaignConfig.messageTemplate,
            mediaUrl: campaignConfig.mediaUrl || null,
            minDelay,
            maxDelay,
            batchSize,
            batchPause,
            overrideSafeHours,
            recipients: cleanRecipients,
            createdAt: new Date().toISOString(),
            status: 'running',
            logs: []
        };

        this.queue = [...cleanRecipients];
        this.currentIndex = 0;
        this.isPaused = false;
        this.isCancelled = false;

        this.stats = {
            campaignId: this.activeCampaign.id,
            campaignName: this.activeCampaign.name,
            total: this.queue.length,
            sent: 0,
            failed: 0,
            status: 'running',
            currentPhone: '',
            currentRecipientName: '',
            nextDelaySec: 0,
            safeHoursHold: false
        };

        storage.addCampaign(this.activeCampaign);
        this.emit('status_change', this.stats);

        this.processQueue();
        return this.activeCampaign;
    }

    clearTimers() {
        if (this.delayTimeout) {
            clearTimeout(this.delayTimeout);
            this.delayTimeout = null;
        }
        if (this.batchInterval) {
            clearInterval(this.batchInterval);
            this.batchInterval = null;
        }
        if (this.safeHoursTimeout) {
            clearTimeout(this.safeHoursTimeout);
            this.safeHoursTimeout = null;
        }
    }

    pauseCampaign() {
        if (this.stats.status === 'running' || this.stats.status === 'safe_hours_hold') {
            this.isPaused = true;
            this.clearTimers();
            this.stats.status = 'paused';
            this.stats.safeHoursHold = false;
            this.emit('status_change', this.stats);
            this.log('Campaign execution paused by operator.', 'warning');
            this.persistActiveState('paused');
        }
    }

    resumeCampaign() {
        if (this.stats.status === 'paused' || this.stats.status === 'safe_hours_hold') {
            this.isPaused = false;
            this.clearTimers();
            this.stats.status = 'running';
            this.stats.safeHoursHold = false;
            if (this.activeCampaign) {
                this.activeCampaign.overrideSafeHours = true;
            }
            this.emit('status_change', this.stats);
            this.log('Campaign manually resumed & override activated by operator.', 'info');
            this.persistActiveState('running');
            this.processQueue();
        }
    }

    stopCampaign() {
        this.isCancelled = true;
        this.clearTimers();
        this.stats.status = 'stopped';
        this.stats.safeHoursHold = false;
        this.emit('status_change', this.stats);
        this.log('Campaign stopped and cancelled by operator.', 'error');
        this.persistActiveState('stopped');
    }

    persistActiveState(status) {
        if (this.activeCampaign) {
            storage.updateCampaign(this.activeCampaign.id, {
                status,
                sentCount: this.stats.sent,
                failedCount: this.stats.failed
            });
        }
    }

    log(message, type = 'info', extra = {}) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            timeStr: new Date().toLocaleTimeString(),
            message,
            type,
            ...extra
        };
        if (this.activeCampaign) {
            if (!this.activeCampaign.logs) this.activeCampaign.logs = [];
            this.activeCampaign.logs.push(logEntry);
            if (this.activeCampaign.logs.length > 300) this.activeCampaign.logs.shift();
        }
        this.emit('log', logEntry);
    }

    async processQueue() {
        if (this.isCancelled || this.isPaused) return;

        if (this.currentIndex >= this.queue.length) {
            this.stats.status = 'completed';
            this.stats.safeHoursHold = false;
            this.emit('status_change', this.stats);
            this.log(`🎉 Campaign completed! Total sent: ${this.stats.sent}, Failed: ${this.stats.failed}`, 'success');
            this.persistActiveState('completed');
            return;
        }

        const settings = storage.getSettings();

        // 1. Check Safe Hours Protection
        if (settings.safeHoursEnabled && !this.activeCampaign.overrideSafeHours && !this.isWithinSafeHours(settings)) {
            const { delayMs, resumeTimeStr } = this.getSafeHoursResumeDetails(settings);
            this.stats.status = 'safe_hours_hold';
            this.stats.safeHoursHold = true;
            this.stats.resumeTimeStr = resumeTimeStr;
            this.emit('status_change', this.stats);
            this.log(`🌙 Safe Hours Active: Pausing dispatch outside marketing window (${settings.safeHoursStart} - ${settings.safeHoursEnd}). Auto-resuming at ${resumeTimeStr} to protect account reputation.`, 'warning');
            
            this.clearTimers();
            this.safeHoursTimeout = setTimeout(() => {
                this.log('☀️ Safe Hours marketing window opened. Resuming broadcast dispatch...', 'info');
                this.stats.safeHoursHold = false;
                this.stats.status = 'running';
                this.emit('status_change', this.stats);
                this.processQueue();
            }, delayMs);
            return;
        }

        // 2. Batch pause protection
        if (this.currentIndex > 0 && this.currentIndex % this.activeCampaign.batchSize === 0) {
            const pauseMins = this.activeCampaign.batchPause;
            this.log(`🛡️ Anti-Ban Cooldown: Taking a ${pauseMins}-minute break after ${this.currentIndex} messages...`, 'warning');
            
            let remainingSecs = pauseMins * 60;
            this.clearTimers();

            this.batchInterval = setInterval(() => {
                if (this.isCancelled || this.isPaused) {
                    this.clearTimers();
                    return;
                }
                remainingSecs -= 1;
                this.emit('batch_countdown', { remainingSeconds: remainingSecs });
                if (remainingSecs <= 0) {
                    this.clearTimers();
                    this.log('Resuming message dispatch after batch cooldown...', 'info');
                    this.sendNext();
                }
            }, 1000);
            return;
        }

        await this.sendNext();
    }

    async sendNext() {
        if (this.isCancelled || this.isPaused) return;

        const recipient = this.queue[this.currentIndex];
        this.currentIndex++;

        const phone = recipient.phone;
        const formattedJid = `${phone}@s.whatsapp.net`;
        const recipientName = recipient.name || 'Valued Client';

        this.stats.currentPhone = phone;
        this.stats.currentRecipientName = recipientName;
        this.emit('status_change', this.stats);

        const settings = storage.getSettings();
        const messageText = replaceVariables(this.activeCampaign.messageTemplate, {
            name: recipientName,
            phone: phone,
            store_name: settings.storeName || 'ELEVATESTORE',
            ...(recipient.customFields || {})
        });

        try {
            this.log(`[${this.currentIndex}/${this.queue.length}] Preparing message for ${recipientName} (+${phone})...`);

            // Realistic Human Typing Simulation
            if (settings.simulateTyping !== false && this.client.simulateTyping) {
                this.log(`✍️ Simulating human typing for ${recipientName}...`);
                await this.client.simulateTyping(formattedJid, messageText);
            } else if (this.client.sendPresence) {
                await this.client.sendPresence(formattedJid, 'composing');
                await new Promise(resolve => setTimeout(resolve, 1500));
            }

            if (this.isCancelled || this.isPaused) return;

            await this.client.sendMessage(formattedJid, messageText, this.activeCampaign.mediaUrl);
            
            this.stats.sent++;
            this.log(`✅ Message delivered to ${recipientName} (+${phone})`, 'success', { phone, name: recipientName });
            
            storage.addOrUpdateContact({
                phone,
                name: recipientName,
                lastCampaign: this.activeCampaign.name,
                status: 'contacted'
            });

        } catch (err) {
            console.error(`Failed delivery to ${phone}:`, err);
            this.stats.failed++;
            this.log(`❌ Failed delivery to +${phone}: ${err.message}`, 'error', { phone, error: err.message });
        }

        this.emit('status_change', this.stats);
        this.persistActiveState('running');

        if (this.currentIndex < this.queue.length && !this.isCancelled && !this.isPaused) {
            const min = this.activeCampaign.minDelay;
            const max = this.activeCampaign.maxDelay;
            const delaySec = Math.floor(Math.random() * (max - min + 1)) + min;
            
            this.stats.nextDelaySec = delaySec;
            this.emit('status_change', this.stats);
            this.log(`⏳ Anti-Ban Throttling: Waiting ${delaySec}s before next message...`);

            this.clearTimers();
            this.delayTimeout = setTimeout(() => {
                this.processQueue();
            }, delaySec * 1000);
        } else {
            this.processQueue();
        }
    }
}

module.exports = CampaignEngine;
