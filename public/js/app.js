// ==========================================================================
// ELEVATESTORE WHATSAPP MARKETING & CRM - CLIENT LOGIC
// ==========================================================================

// Connect Socket.io client
const socket = io();

// Application State
let appState = {
    whatsappStatus: 'disconnected',
    qrDataUrl: null,
    user: null,
    currentView: 'dashboard',
    contacts: [],
    chats: {},
    activeChatJid: null,
    autoReplies: [],
    campaigns: [],
    activeCampaignStats: null,
    parsedRecipients: [],
    settings: {
        storeName: 'ELEVATESTORE',
        phone: '',
        minDelaySeconds: 15,
        maxDelaySeconds: 45,
        batchSize: 20,
        batchPauseMinutes: 2,
        autoReplyEnabled: true,
        soundNotifications: true
    }
};

// Template Presets
const CAMPAIGN_PRESETS = {
    new_arrivals: {
        name: 'New Signature Arrivals & Lookbook',
        message: `{Hello|Hi|Greetings} {{name}}! 👋
The latest luxury collection has just arrived at *ELEVATESTORE*! ✨

👗 Exclusive Designer Dresses & Haute Couture
👔 Tailored Shirts, Polos & Contemporary Denim
👠 Premium Footwear & Boutique Accessories

🔥 Enjoy an exclusive *15% Welcome Discount* this week!
Reply *CATALOG* to view our instant photo lookbook or ask for your size. 🛍️`
    },
    weekend_sale: {
        name: 'Weekend Private Flash Sale',
        message: `{Hello|Greetings} {{name}}! ✨
Special Weekend Announcement from *ELEVATESTORE*:

Take *20% OFF* on all selected evening wear, suits, and luxury dresses this Friday to Sunday only! 🏷️

🚚 Nationwide express door-to-door delivery available.
Reply *OFFER* to claim your coupon code or reserve your piece before stock runs out! 💃`
    },
    vip_invitation: {
        name: 'VIP Client Private Lookbook Invitation',
        message: `{Dear|Hello} {{name}}, 👑
As a valued client of *ELEVATESTORE*, we invite you to an exclusive preview of our private seasonal lookbook before public release.

✨ Hand-crafted fabrics, limited-edition cuts, and complimentary styling concierge.

Would you like us to send the VIP digital lookbook to you right now? Reply *YES* to receive it. 👇`
    },
    follow_up: {
        name: 'Client Order & Sizing Follow-Up',
        message: `{Hello|Hi} {{name}}! 👋
Following up from *ELEVATESTORE* — did you find the size and design you were looking for from our latest collection?

We are happy to assist with bespoke fit recommendations, custom reservations, or same-day delivery. Let us know how we can style you today! 💫`
    }
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initSocketListeners();
    loadAllData();
    initMessageComposerLivePreview();
    setupDropZone();
    loadTemplatePreset('new_arrivals');
    updateHeaderDate();
});

function updateHeaderDate() {
    const d = new Date();
    const dateEl = document.getElementById('dashCurrentDate');
    if (dateEl) {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        dateEl.innerText = `${dd}.${mm}.${yyyy}`;
    }
}

// Toast Notification Manager
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'fa-circle-check' : (type === 'error' ? 'fa-triangle-exclamation' : 'fa-info-circle');
    toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// View Navigation
function initNavigation() {
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const view = item.getAttribute('data-view');
            switchView(view);
        });
    });
}

function switchView(viewName) {
    appState.currentView = viewName;
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-view') === viewName);
    });

    document.querySelectorAll('.view-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `view-${viewName}`);
    });

    const viewNames = {
        dashboard: 'Overview',
        campaign: 'Broadcasts',
        inbox: 'Messenger',
        autoreply: 'Auto-Reply',
        contacts: 'CRM Leads',
        settings: 'Settings'
    };

    const label = document.getElementById('topBarActiveViewLabel');
    if (label && viewNames[viewName]) {
        label.innerText = viewNames[viewName];
    }

    if (viewName === 'inbox' && appState.activeChatJid) {
        markChatRead(appState.activeChatJid);
    }
}

// Socket.io Real-time Event Handlers
function initSocketListeners() {
    socket.on('whatsapp:status', (data) => {
        appState.whatsappStatus = data.status;
        appState.qrDataUrl = data.qrDataUrl;
        appState.user = data.user;
        updateWhatsAppUI();
    });

    socket.on('whatsapp:qr', (data) => {
        appState.qrDataUrl = data.qrDataUrl;
        appState.whatsappStatus = 'qr_ready';
        updateWhatsAppUI();
    });

    socket.on('chat:message', (msg) => {
        handleIncomingChatMessage(msg);
    });

    socket.on('chat:updated', (chat) => {
        appState.chats[chat.jid] = chat;
        renderConversationsList();
        updateUnreadBadge();
    });

    socket.on('chat:deleted', (data) => {
        if (appState.chats[data.jid]) {
            delete appState.chats[data.jid];
            if (appState.activeChatJid === data.jid) {
                appState.activeChatJid = null;
                const ph = document.getElementById('emptyChatPlaceholder');
                const ac = document.getElementById('activeChatContent');
                if (ph) ph.style.display = 'flex';
                if (ac) ac.style.display = 'none';
            }
            renderConversationsList();
            updateUnreadBadge();
        }
    });

    socket.on('chat:cleared_all', () => {
        appState.chats = {};
        appState.activeChatJid = null;
        const ph = document.getElementById('emptyChatPlaceholder');
        const ac = document.getElementById('activeChatContent');
        if (ph) ph.style.display = 'flex';
        if (ac) ac.style.display = 'none';
        renderConversationsList();
        updateUnreadBadge();
    });

    socket.on('campaign:stats', (stats) => {
        appState.activeCampaignStats = stats;
        updateCampaignMonitorUI(stats);
        if (stats.status === 'completed' || stats.status === 'stopped' || stats.status === 'idle') {
            refreshCampaignsData();
        }
    });

    socket.on('campaign:log', (logEntry) => {
        appendLiveLog(logEntry);
    });

    socket.on('campaign:countdown', (data) => {
        const el = document.getElementById('liveDelayCountdown');
        if (el) el.innerText = `${data.remainingSeconds}s (Cooldown)`;
    });
}

async function refreshCampaignsData() {
    try {
        const res = await fetch('/api/campaigns').then(r => r.json());
        if (res && res.campaigns) {
            appState.campaigns = res.campaigns;
            renderCampaignsTable();
            
            // Recalculate delivered totals
            let totalSentToday = 0;
            let totalFailed = 0;
            res.campaigns.forEach(c => {
                totalSentToday += (c.sentCount || 0);
                totalFailed += (c.failedCount || 0);
            });
            const statSent = document.getElementById('statSentMessages');
            if (statSent) statSent.innerText = `${totalSentToday} Msgs`;

            const rateEl = document.getElementById('statDeliveryRate');
            if (rateEl) {
                const sum = totalSentToday + totalFailed;
                const rate = sum > 0 ? Math.round((totalSentToday / sum) * 100) : 100;
                rateEl.innerText = `${rate}%`;
            }
        }
    } catch (e) {
        console.error('Error refreshing campaigns:', e);
    }
}

function updateWhatsAppUI() {
    const dot = document.getElementById('waStatusDot');
    const text = document.getElementById('waStatusText');
    const qrLoading = document.getElementById('qrLoadingSpinner');
    const qrImageContainer = document.getElementById('qrImageContainer');
    const qrImg = document.getElementById('qrImageElement');
    const qrConnectedState = document.getElementById('qrConnectedState');
    const headerPhone = document.getElementById('headerUserPhone');

    if (dot) dot.className = 'status-dot ' + appState.whatsappStatus;

    if (appState.whatsappStatus === 'connected') {
        if (text) text.innerText = 'Connected (Live)';
        if (headerPhone) headerPhone.innerText = appState.user?.phone ? `+${appState.user.phone}` : 'Connected';

        if (qrLoading) qrLoading.style.display = 'none';
        if (qrImageContainer) qrImageContainer.style.display = 'none';
        if (qrConnectedState) qrConnectedState.style.display = 'block';
        const userMeta = document.getElementById('connectedUserMeta');
        if (userMeta) userMeta.innerText = `Active Number: +${appState.user?.phone || ''} | ${appState.user?.name || 'ELEVATESTORE'}`;

    } else if (appState.whatsappStatus === 'qr_ready') {
        if (text) text.innerText = 'Scan QR Code';
        if (headerPhone) headerPhone.innerText = 'Scan QR';

        if (qrLoading) qrLoading.style.display = 'none';
        if (qrConnectedState) qrConnectedState.style.display = 'none';
        if (qrImageContainer) qrImageContainer.style.display = 'block';
        if (appState.qrDataUrl && qrImg) {
            qrImg.src = appState.qrDataUrl;
        }

    } else {
        if (text) text.innerText = 'Connecting...';
        if (headerPhone) headerPhone.innerText = 'Connecting...';

        if (qrConnectedState) qrConnectedState.style.display = 'none';
        if (qrImageContainer) qrImageContainer.style.display = 'none';
        if (qrLoading) qrLoading.style.display = 'block';
    }
}

// Modal Handlers
function openQrModal() {
    const modal = document.getElementById('qrModal');
    if (modal) modal.classList.add('active');
}

function closeQrModal() {
    const modal = document.getElementById('qrModal');
    if (modal) modal.classList.remove('active');
}

async function handleLogoutWhatsApp() {
    if (confirm('Are you sure you want to disconnect this WhatsApp session?')) {
        await fetch('/api/whatsapp/restart', { method: 'POST' });
        showToast('WhatsApp session reset. Generating fresh QR code...', 'info');
        closeQrModal();
    }
}

// Load All Initial Data
async function loadAllData() {
    try {
        const [statusRes, chatsRes, contactsRes, autoRes, campsRes, setRes] = await Promise.all([
            fetch('/api/whatsapp/status').then(r => r.json()),
            fetch('/api/chats').then(r => r.json()),
            fetch('/api/contacts').then(r => r.json()),
            fetch('/api/autoreplies').then(r => r.json()),
            fetch('/api/campaigns').then(r => r.json()),
            fetch('/api/settings').then(r => r.json())
        ]);

        appState.whatsappStatus = statusRes.status;
        appState.qrDataUrl = statusRes.qrDataUrl;
        appState.user = statusRes.user;
        updateWhatsAppUI();

        appState.chats = chatsRes || {};
        renderConversationsList();
        updateUnreadBadge();

        appState.contacts = contactsRes || [];
        renderContactsTable();
        
        const count = appState.contacts.length || 0;
        const totalLeadsText = count.toLocaleString();
        
        const statTotalContacts = document.getElementById('statTotalContacts');
        if (statTotalContacts) statTotalContacts.innerText = `${totalLeadsText} Leads`;
        
        const statHeroTotalLeads = document.getElementById('statHeroTotalLeads');
        if (statHeroTotalLeads) statHeroTotalLeads.innerText = totalLeadsText;

        const dashLeadsCount = document.getElementById('dashLeadsCount');
        if (dashLeadsCount) dashLeadsCount.innerHTML = `${totalLeadsText} <span>/active contacts</span>`;

        const savedLeadsCount = document.getElementById('savedLeadsCount');
        if (savedLeadsCount) savedLeadsCount.innerText = count;

        const dashNewBadge = document.getElementById('dashNewLeadsBadge');
        if (dashNewBadge) dashNewBadge.innerText = count;

        // Calculate Delivered Today from all campaigns
        let totalSentToday = 0;
        let totalFailed = 0;
        (campsRes.campaigns || []).forEach(c => {
            totalSentToday += (c.sentCount || 0);
            totalFailed += (c.failedCount || 0);
        });
        const statSent = document.getElementById('statSentMessages');
        if (statSent) statSent.innerText = `${totalSentToday} Msgs`;

        const rateEl = document.getElementById('statDeliveryRate');
        if (rateEl) {
            const sum = totalSentToday + totalFailed;
            const rate = sum > 0 ? Math.round((totalSentToday / sum) * 100) : 100;
            rateEl.innerText = `${rate}%`;
        }
        if (savedLeadsCount) savedLeadsCount.innerText = count;

        appState.autoReplies = autoRes || [];
        renderAutoRepliesGrid();

        appState.campaigns = campsRes.campaigns || [];
        renderCampaignsTable();

        if (campsRes.activeStats && campsRes.activeStats.status === 'running') {
            appState.activeCampaignStats = campsRes.activeStats;
            updateCampaignMonitorUI(campsRes.activeStats);
        }

        appState.settings = setRes || appState.settings;
        populateSettingsForm();

    } catch (err) {
        console.error('Error loading data:', err);
    }
}

// Global Filter States
let currentInboxFilter = 'all';
let currentContactStatusFilter = 'all';

function getAvatarGradient(str = '') {
    const gradients = [
        'linear-gradient(135deg, #38e54d, #10b981)',
        'linear-gradient(135deg, #f59e0b, #d97706)',
        'linear-gradient(135deg, #3b82f6, #1d4ed8)',
        'linear-gradient(135deg, #8b5cf6, #6d28d9)',
        'linear-gradient(135deg, #ec4899, #be185d)',
        'linear-gradient(135deg, #06b6d4, #0891b2)'
    ];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const index = Math.abs(hash) % gradients.length;
    return gradients[index];
}

function setInboxFilter(filter) {
    currentInboxFilter = filter;
    document.querySelectorAll('.chat-filter-pill').forEach(pill => {
        pill.classList.remove('active');
    });
    if (event && event.currentTarget) {
        event.currentTarget.classList.add('active');
    }
    renderConversationsList();
}

// LIVE INBOX & CHAT
function renderConversationsList() {
    const container = document.getElementById('conversationsContainer');
    const recentDashboard = document.getElementById('dashboardRecentChats');
    let chatArray = Object.values(appState.chats).sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));

    // Apply Inbox Filters
    if (currentInboxFilter === 'unread') {
        chatArray = chatArray.filter(c => (c.unreadCount || 0) > 0);
    } else if (currentInboxFilter === 'hot') {
        chatArray = chatArray.filter(c => c.messages && c.messages.some(m => !m.fromMe));
    }

    if (chatArray.length === 0) {
        if (container) {
            const filterLabel = currentInboxFilter === 'unread' ? 'No unread messages' : (currentInboxFilter === 'hot' ? 'No incoming client replies yet' : 'No client conversations yet');
            container.innerHTML = `<div style="padding: 32px 16px; text-align: center; color: var(--text-muted); font-size: 0.8rem;"><i class="fa-regular fa-comment-dots" style="font-size: 1.8rem; opacity: 0.4; margin-bottom: 8px;"></i><p>${filterLabel}.</p></div>`;
        }
        return;
    }

    let html = '';
    let dashboardHtml = '';

    chatArray.forEach(chat => {
        const isActive = appState.activeChatJid === chat.jid ? 'active' : '';
        const initial = (chat.name || 'C')[0].toUpperCase();
        const timeStr = formatChatTime(chat.lastTimestamp);
        const unreadBadge = chat.unreadCount > 0 ? `<span class="client-badge-pill" style="background:#ef4444; color:#fff; font-weight:700;">${chat.unreadCount}</span>` : '';
        const hasReply = chat.messages && chat.messages.some(m => !m.fromMe);
        const hotLeadIndicator = hasReply ? `<span style="color:var(--accent-amber); font-size:0.75rem; margin-right:4px;" title="Client Replied">🔥</span>` : '';
        const bgGrad = getAvatarGradient(chat.jid);

        html += `
            <div class="chat-list-item ${isActive}" onclick="selectConversation('${chat.jid}')">
                <div class="chat-item-avatar" style="background: ${bgGrad}; color: #07090b;">${initial}</div>
                <div class="chat-item-info">
                    <div class="chat-item-top">
                        <span class="chat-item-name">${hotLeadIndicator}${escapeHtml(chat.name || chat.jid.split('@')[0])}</span>
                        <span class="chat-item-time">${timeStr}</span>
                    </div>
                    <div class="chat-item-preview">${escapeHtml(chat.lastMessage || 'No messages yet')}</div>
                </div>
                ${unreadBadge}
            </div>
        `;
    });

    if (container) container.innerHTML = html;

    if (recentDashboard && chatArray.length > 0) {
        chatArray.slice(0, 4).forEach(chat => {
            const timeStr = formatChatTime(chat.lastTimestamp);
            dashboardHtml += `
                <div class="client-pill-item" onclick="switchView('inbox'); selectConversation('${chat.jid}')" style="cursor:pointer;">
                    <div class="client-meta-side">
                        <small>${timeStr || 'Recent Message'}</small>
                        <strong>${escapeHtml(chat.name || chat.jid.split('@')[0])}</strong>
                    </div>
                    <span class="client-badge-pill">+Client</span>
                </div>
            `;
        });
        recentDashboard.innerHTML = dashboardHtml;
    }
}

function selectConversation(jid) {
    appState.activeChatJid = jid;
    const chat = appState.chats[jid];
    if (!chat) return;

    const chatContainer = document.querySelector('.chat-app-container');
    if (chatContainer) chatContainer.classList.add('mobile-chat-open');

    const placeholder = document.getElementById('emptyChatPlaceholder');
    const content = document.getElementById('activeChatContent');

    if (placeholder) placeholder.style.display = 'none';
    if (content) content.style.display = 'flex';

    const isLid = jid.endsWith('@lid');
    const nameEl = document.getElementById('activeChatName');
    if (nameEl) nameEl.innerText = chat.name || (isLid ? 'WhatsApp Contact' : jid.split('@')[0]);

    const phoneEl = document.getElementById('activeChatPhone');
    if (phoneEl) {
        if (chat.phone) {
            phoneEl.innerText = `+${chat.phone}`;
        } else if (isLid) {
            phoneEl.innerText = 'WhatsApp Contact';
        } else {
            phoneEl.innerText = `+${chat.jid.split('@')[0]}`;
        }
    }

    const avatarEl = document.getElementById('activeChatAvatar');
    if (avatarEl) avatarEl.innerText = (chat.name || 'C')[0].toUpperCase();

    renderChatMessages(chat);
    markChatRead(jid);
    renderConversationsList();
}

function closeMobileChat() {
    const chatContainer = document.querySelector('.chat-app-container');
    if (chatContainer) chatContainer.classList.remove('mobile-chat-open');
    appState.activeChatJid = null;
    const placeholder = document.getElementById('emptyChatPlaceholder');
    const content = document.getElementById('activeChatContent');
    if (placeholder) placeholder.style.display = 'flex';
    if (content) content.style.display = 'none';
    renderConversationsList();
}

function renderChatMessages(chat) {
    const body = document.getElementById('chatMessagesBody');
    if (!body) return;

    if (!chat.messages || chat.messages.length === 0) {
        body.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:30px;">Start a conversation with this client.</div>`;
        return;
    }

    let html = '';
    chat.messages.forEach(msg => {
        const rowClass = msg.fromMe ? 'sent' : 'received';
        const timeStr = formatMsgTime(msg.timestamp);

        let mediaTag = '';
        if (msg.hasMedia) {
            mediaTag = `<div style="font-size:0.75rem; color:var(--accent-lime); margin-bottom:4px;"><i class="fa-solid fa-image"></i> Media Attachment</div>`;
        }

        html += `
            <div class="chat-msg-row ${rowClass}">
                <div class="chat-msg-bubble">
                    ${mediaTag}
                    <div>${escapeHtml(msg.text)}</div>
                    <div class="chat-msg-time">${timeStr}</div>
                </div>
            </div>
        `;
    });

    body.innerHTML = html;
    body.scrollTop = body.scrollHeight;
}

function handleIncomingChatMessage(msg) {
    if (!appState.chats[msg.jid]) {
        appState.chats[msg.jid] = {
            jid: msg.jid,
            name: msg.senderName || msg.jid.split('@')[0],
            unreadCount: 0,
            lastMessage: msg.text,
            lastTimestamp: msg.timestamp,
            messages: []
        };
    }

    const chat = appState.chats[msg.jid];
    chat.lastMessage = msg.text;
    chat.lastTimestamp = msg.timestamp;
    if (msg.senderName && msg.senderName !== 'You') chat.name = msg.senderName;

    if (!msg.fromMe) {
        chat.unreadCount = (chat.unreadCount || 0) + 1;
        showToast(`New client message from ${chat.name}`, 'info');
        if (appState.settings.soundNotifications) {
            try { document.getElementById('notificationSound').play(); } catch(e){}
        }
    }

    chat.messages.push(msg);

    if (appState.activeChatJid === msg.jid) {
        renderChatMessages(chat);
        markChatRead(msg.jid);
    }

    renderConversationsList();
    updateUnreadBadge();
}

async function markChatRead(jid) {
    if (appState.chats[jid]) {
        appState.chats[jid].unreadCount = 0;
        socket.emit('chat:mark_read', jid);
        updateUnreadBadge();
    }
}

function updateUnreadBadge() {
    let unreadTotal = 0;
    let totalReplies = 0;
    Object.values(appState.chats).forEach(c => {
        if (c.unreadCount) unreadTotal += c.unreadCount;
        if (c.messages && c.messages.some(m => !m.fromMe)) totalReplies++;
    });

    const badge = document.getElementById('unreadInboxBadge');
    if (badge) {
        if (unreadTotal > 0) {
            badge.innerText = unreadTotal;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }

    const statReplies = document.getElementById('statTotalReplies');
    if (statReplies) statReplies.innerText = `${totalReplies} Inquiries`;

    const dashHotBadge = document.getElementById('dashHotLeadsBadge');
    if (dashHotBadge) dashHotBadge.innerText = totalReplies;
}

async function sendActiveChatMessage() {
    const input = document.getElementById('chatTextInput');
    const text = input.value.trim();
    const mediaInput = document.getElementById('chatMediaInput');
    const file = mediaInput.files[0];

    if (!text && !file) return;
    if (!appState.activeChatJid) return;

    const formData = new FormData();
    formData.append('jid', appState.activeChatJid);
    formData.append('text', text);
    if (file) {
        formData.append('media', file);
    }

    input.value = '';
    cancelChatMedia();

    try {
        await fetch('/api/chats/send', {
            method: 'POST',
            body: formData
        });
    } catch (err) {
        showToast('Failed to deliver message: ' + err.message, 'error');
    }
}

function handleChatKeyPress(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendActiveChatMessage();
    }
}

function sendQuickText(text) {
    const input = document.getElementById('chatTextInput');
    if (input) {
        input.value = text;
        sendActiveChatMessage();
    }
}

function handleChatMediaSelect(input) {
    const file = input.files[0];
    if (file) {
        document.getElementById('chatMediaFileName').innerText = file.name;
        document.getElementById('chatMediaPreview').style.display = 'flex';
    }
}

function cancelChatMedia() {
    document.getElementById('chatMediaInput').value = '';
    document.getElementById('chatMediaPreview').style.display = 'none';
}

function filterChatList() {
    const query = document.getElementById('chatSearchInput').value.toLowerCase();
    const items = document.querySelectorAll('.chat-list-item');
    items.forEach(el => {
        const text = el.innerText.toLowerCase();
        el.style.display = text.includes(query) ? 'flex' : 'none';
    });
}

async function confirmDeleteActiveChat() {
    if (!appState.activeChatJid) return;
    const chat = appState.chats[appState.activeChatJid];
    const clientName = chat?.name || 'this client';

    if (confirm(`Are you sure you want to delete the chat history with ${clientName}?`)) {
        const jid = appState.activeChatJid;
        try {
            const res = await fetch(`/api/chats/${encodeURIComponent(jid)}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                delete appState.chats[jid];
                appState.activeChatJid = null;
                const ph = document.getElementById('emptyChatPlaceholder');
                const ac = document.getElementById('activeChatContent');
                if (ph) ph.style.display = 'flex';
                if (ac) ac.style.display = 'none';
                renderConversationsList();
                updateUnreadBadge();
                showToast(`Deleted chat with ${clientName}.`, 'info');
            }
        } catch (err) {
            showToast('Failed to delete chat: ' + err.message, 'error');
        }
    }
}

async function confirmClearAllChats() {
    const totalChats = Object.keys(appState.chats).length;
    if (totalChats === 0) {
        showToast('No active chats to clear.', 'info');
        return;
    }

    if (confirm(`Are you sure you want to clear ALL ${totalChats} chat conversations? This will erase local chat history.`)) {
        try {
            const res = await fetch('/api/chats/clear_all', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                appState.chats = {};
                appState.activeChatJid = null;
                const ph = document.getElementById('emptyChatPlaceholder');
                const ac = document.getElementById('activeChatContent');
                if (ph) ph.style.display = 'flex';
                if (ac) ac.style.display = 'none';
                renderConversationsList();
                updateUnreadBadge();
                showToast('All chat history cleared successfully.', 'success');
            }
        } catch (err) {
            showToast('Failed to clear chats: ' + err.message, 'error');
        }
    }
}

// CAMPAIGN BUILDER & BULK SENDER
function setRecipientMode(mode) {
    document.querySelectorAll('.recipients-method-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');

    document.getElementById('recipModeFile').style.display = mode === 'file' ? 'block' : 'none';
    document.getElementById('recipModeText').style.display = mode === 'text' ? 'block' : 'none';
    document.getElementById('recipModeSaved').style.display = mode === 'saved' ? 'block' : 'none';
}

function setupDropZone() {
    const zone = document.getElementById('fileDropZone');
    const input = document.getElementById('contactsFileInput');
    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.style.borderColor = 'var(--accent-lime)';
    });
    zone.addEventListener('dragleave', () => {
        zone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
    });
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
        if (e.dataTransfer.files.length) {
            input.files = e.dataTransfer.files;
            handleFileUpload(input);
        }
    });
}

async function handleFileUpload(input) {
    const file = input.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    const statusInfo = document.getElementById('fileUploadStatus');
    statusInfo.style.display = 'block';
    statusInfo.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing and validating <strong>${file.name}</strong>...`;

    try {
        const res = await fetch('/api/contacts/import', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        if (data.success) {
            appState.parsedRecipients = data.contacts;
            statusInfo.innerHTML = `<span style="color: var(--accent-lime);"><i class="fa-solid fa-circle-check"></i> Import success! <strong>${data.totalImported}</strong> valid phone numbers ready.</span>`;
            updateRecipientsSummary();
            showToast(`Loaded ${data.totalImported} contacts from ${file.name}`, 'success');
            loadAllData();
        } else {
            statusInfo.innerHTML = `<span style="color: #ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> Error: ${data.error}</span>`;
        }
    } catch (err) {
        statusInfo.innerHTML = `<span style="color: #ef4444;">File upload error: ${err.message}</span>`;
    }
}

function parseManualRecipients(silent = false) {
    const input = document.getElementById('manualRecipientsInput');
    if (!input) return;
    const text = input.value;
    const lines = text.split(/\r?\n/);
    const recipients = [];
    const seen = new Set();

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // Split by comma, tab, semicolon, colon, or pipe
        const parts = trimmed.split(/[,;\t|:]+/);
        let rawPhone = parts[0] ? parts[0].trim() : '';
        let cleanPhone = rawPhone.replace(/[^0-9]/g, '');
        let name = parts.slice(1).join(' ').trim() || 'Valued Client';

        // If phone wasn't the first item (e.g. "Monet, 0711472706"), search for digit block
        if (cleanPhone.length < 9) {
            for (let i = 0; i < parts.length; i++) {
                const digits = parts[i].replace(/[^0-9]/g, '');
                if (digits.length >= 9) {
                    cleanPhone = digits;
                    name = parts.filter((_, idx) => idx !== i).join(' ').trim() || 'Valued Client';
                    break;
                }
            }
        }

        if (cleanPhone.length >= 9) {
            if (cleanPhone.startsWith('0') && cleanPhone.length === 10) cleanPhone = '255' + cleanPhone.substring(1);
            else if (cleanPhone.length === 9 && (cleanPhone.startsWith('6') || cleanPhone.startsWith('7'))) cleanPhone = '255' + cleanPhone;

            if (!seen.has(cleanPhone)) {
                seen.add(cleanPhone);
                recipients.push({ phone: cleanPhone, name });
            }
        }
    });

    appState.parsedRecipients = recipients;
    updateRecipientsSummary();
    if (!silent) {
        if (recipients.length > 0) {
            showToast(`Validated ${recipients.length} phone recipient(s) successfully!`, 'success');
        } else {
            showToast('No valid phone numbers found. Use format: 07XXXXXXXX, Name', 'error');
        }
    }
}

function useAllSavedContacts() {
    if (appState.contacts.length === 0) {
        showToast('No saved contacts found in CRM database.', 'error');
        return;
    }
    appState.parsedRecipients = appState.contacts.map(c => ({ phone: c.phone, name: c.name || 'Valued Client' }));
    updateRecipientsSummary();
    showToast(`Targeted all ${appState.contacts.length} saved CRM contacts!`, 'success');
}

function updateRecipientsSummary() {
    const summaryBox = document.getElementById('recipientsSummaryBox');
    const countEl = document.getElementById('validRecipientsCount');

    if (appState.parsedRecipients.length > 0) {
        if (countEl) countEl.innerText = appState.parsedRecipients.length;
        if (summaryBox) summaryBox.style.display = 'flex';
    } else {
        if (summaryBox) summaryBox.style.display = 'none';
    }
}

function clearRecipients() {
    appState.parsedRecipients = [];
    document.getElementById('contactsFileInput').value = '';
    document.getElementById('manualRecipientsInput').value = '';
    const status = document.getElementById('fileUploadStatus');
    if (status) status.style.display = 'none';
    updateRecipientsSummary();
    showToast('Recipient list cleared.', 'info');
}

function insertVariable(tag) {
    const textarea = document.getElementById('campMessageText');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    textarea.value = text.substring(0, start) + tag + text.substring(end);
    textarea.focus();
    updateLivePreview();
}

function insertSpintax() {
    insertVariable('{Hello|Hi|Greetings}');
}

function loadTemplatePreset(key) {
    const preset = CAMPAIGN_PRESETS[key];
    if (preset) {
        document.getElementById('campName').value = preset.name;
        document.getElementById('campMessageText').value = preset.message;
        onCampaignMessageInput();
        showToast(`Loaded template: "${preset.name}"`, 'info');
    }
}

function calculateClientSpintaxVariations(text) {
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

function onCampaignMessageInput() {
    updateLivePreview();
    const text = document.getElementById('campMessageText').value;
    const count = calculateClientSpintaxVariations(text);
    const countEl = document.getElementById('spintaxVariationsCount');
    if (countEl) countEl.innerText = count.toLocaleString();
    checkSafeHoursWindow();
}

function initMessageComposerLivePreview() {
    const textarea = document.getElementById('campMessageText');
    if (textarea) textarea.addEventListener('input', onCampaignMessageInput);
    checkSafeHoursWindow();
}

function updateLivePreview() {
    const text = document.getElementById('campMessageText').value;
    const preview = document.getElementById('liveMsgPreview');
    if (!preview) return;

    let parsed = text.replace(/\{([^{}]+)\}/g, (m, choices) => choices.split('|')[0].trim());
    parsed = parsed.replace(/\{\{name\}\}/gi, 'Victoria');
    parsed = parsed.replace(/\{\{phone\}\}/gi, '+255 754 000 111');
    parsed = parsed.replace(/\{\{store_name\}\}/gi, 'ELEVATESTORE');

    preview.innerText = parsed || 'Compose your message to view the client preview...';
}

async function previewSpintaxSamples() {
    const text = document.getElementById('campMessageText').value.trim();
    if (!text) {
        showToast('Please type a message with {A|B} spintax first!', 'error');
        return;
    }

    try {
        const res = await fetch('/api/campaigns/spintax-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageTemplate: text })
        });
        const data = await res.json();
        if (data.success && data.samples) {
            const list = document.getElementById('spintaxSamplesList');
            const tray = document.getElementById('spintaxSamplesTray');
            if (list && tray) {
                list.innerHTML = data.samples.map((s, i) => `
                    <div class="spintax-sample-card">
                        <div style="font-size: 0.68rem; color: var(--accent-lime); margin-bottom: 2px; font-weight: 700;">Sample Variation #${i + 1}:</div>
                        ${escapeHtml(s)}
                    </div>
                `).join('');
                tray.style.display = 'block';
            }
        }
    } catch (err) {
        showToast('Error generating variations: ' + err.message, 'error');
    }
}

function closeSpintaxSamples() {
    const tray = document.getElementById('spintaxSamplesTray');
    if (tray) tray.style.display = 'none';
}

function checkSafeHoursWindow() {
    const notice = document.getElementById('campSafeHoursNotice');
    if (!notice) return;

    const settings = appState.settings;
    if (!settings.safeHoursEnabled) {
        notice.style.display = 'none';
        return;
    }

    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = (settings.safeHoursStart || '08:00').split(':').map(Number);
    const [endH, endM] = (settings.safeHoursEnd || '21:00').split(':').map(Number);

    const startTotal = (isNaN(startH) ? 8 : startH) * 60 + (isNaN(startM) ? 0 : startM);
    const endTotal = (isNaN(endH) ? 21 : endH) * 60 + (isNaN(endM) ? 0 : endM);

    let isSafe = false;
    if (startTotal <= endTotal) {
        isSafe = currentMins >= startTotal && currentMins <= endTotal;
    } else {
        isSafe = currentMins >= startTotal || currentMins <= endTotal;
    }

    const lbl = document.getElementById('campSafeHoursWindowLabel');
    if (lbl) lbl.innerText = `${settings.safeHoursStart || '08:00'} - ${settings.safeHoursEnd || '21:00'}`;

    notice.style.display = isSafe ? 'none' : 'block';
}

function previewMedia(input) {
    const file = input.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            document.getElementById('mediaPreviewImg').src = e.target.result;
            document.getElementById('mediaPreviewBox').style.display = 'block';
        };
        reader.readAsDataURL(file);
    }
}

function removeMedia() {
    document.getElementById('campMediaFile').value = '';
    document.getElementById('mediaPreviewBox').style.display = 'none';
}

async function handleStartCampaign(e) {
    e.preventDefault();

    if (appState.whatsappStatus !== 'connected') {
        showToast('Please scan the QR code to connect WhatsApp before broadcasting!', 'error');
        openQrModal();
        return;
    }

    if (appState.parsedRecipients.length === 0) {
        const manualText = document.getElementById('manualRecipientsInput')?.value.trim();
        if (manualText) {
            parseManualRecipients(true);
        }
    }

    if (appState.parsedRecipients.length === 0) {
        showToast('Please upload or specify target phone recipients first!', 'error');
        return;
    }

    const name = document.getElementById('campName').value.trim();
    const messageTemplate = document.getElementById('campMessageText').value.trim();
    const minDelay = document.getElementById('inputMinDelay').value;
    const maxDelay = document.getElementById('inputMaxDelay').value;
    const batchSize = document.getElementById('inputBatchSize').value;
    const batchPauseMinutes = document.getElementById('inputBatchPause').value;
    const overrideSafeHours = document.getElementById('checkOverrideSafeHours')?.checked || false;
    const mediaFile = document.getElementById('campMediaFile').files[0];

    const formData = new FormData();
    formData.append('name', name);
    formData.append('messageTemplate', messageTemplate);
    formData.append('recipients', JSON.stringify(appState.parsedRecipients));
    formData.append('minDelay', minDelay);
    formData.append('maxDelay', maxDelay);
    formData.append('batchSize', batchSize);
    formData.append('batchPauseMinutes', batchPauseMinutes);
    formData.append('overrideSafeHours', overrideSafeHours);

    if (mediaFile) {
        formData.append('media', mediaFile);
    }

    try {
        const res = await fetch('/api/campaigns/start', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        if (data.success) {
            showToast(`Campaign "${name}" launched successfully!`, 'success');
            switchView('campaign');
            document.getElementById('liveCampaignCard').scrollIntoView({ behavior: 'smooth' });
        } else {
            showToast('Error: ' + data.error, 'error');
        }
    } catch (err) {
        showToast('Broadcast error: ' + err.message, 'error');
    }
}

function updateCampaignMonitorUI(stats) {
    const liveCard = document.getElementById('liveCampaignCard');
    const runningBadge = document.getElementById('campaignRunningBadge');
    const safeHoursAlert = document.getElementById('liveSafeHoursAlert');

    if (!stats || stats.status === 'idle') {
        if (liveCard) liveCard.style.display = 'none';
        if (runningBadge) runningBadge.style.display = 'none';
        if (safeHoursAlert) safeHoursAlert.style.display = 'none';
        return;
    }

    if (liveCard) liveCard.style.display = 'block';
    if (runningBadge) runningBadge.style.display = (stats.status === 'running' || stats.status === 'safe_hours_hold') ? 'inline-block' : 'none';

    if (safeHoursAlert) {
        if (stats.safeHoursHold) {
            safeHoursAlert.style.display = 'flex';
            const resumeEl = document.getElementById('liveResumeTimeLabel');
            if (resumeEl) resumeEl.innerText = stats.resumeTimeStr || '08:00 AM';
        } else {
            safeHoursAlert.style.display = 'none';
        }
    }

    document.getElementById('liveCampName').innerText = stats.campaignName || 'ELEVATESTORE Broadcast';
    document.getElementById('liveTotalCount').innerText = stats.total || 0;
    document.getElementById('liveSentCount').innerText = stats.sent || 0;
    document.getElementById('liveFailedCount').innerText = stats.failed || 0;
    
    const statSent = document.getElementById('statSentMessages');
    if (statSent) statSent.innerText = `${stats.sent || 0} Msgs`;

    const pct = stats.total > 0 ? Math.round(((stats.sent + stats.failed) / stats.total) * 100) : 0;
    const progressFill = document.getElementById('liveCampProgressFill');
    if (progressFill) progressFill.style.width = `${pct}%`;

    const statusDesc = {
        running: `Delivering to ${stats.currentRecipientName || 'client'} (+${stats.currentPhone || ''})`,
        safe_hours_hold: `🌙 Safe Hours Hold: Resting safely until ${stats.resumeTimeStr || 'morning'}`,
        paused: 'Broadcast temporarily paused by operator.',
        completed: '🎉 Broadcast campaign completed successfully!',
        stopped: 'Broadcast campaign stopped by operator.'
    };
    document.getElementById('liveCampStatus').innerText = statusDesc[stats.status] || stats.status;

    const pauseBtn = document.getElementById('btnPauseCamp');
    const resumeBtn = document.getElementById('btnResumeCamp');
    if (pauseBtn) pauseBtn.style.display = stats.status === 'running' ? 'inline-flex' : 'none';
    if (resumeBtn) {
        resumeBtn.style.display = (stats.status === 'paused' || stats.status === 'safe_hours_hold') ? 'inline-flex' : 'none';
        if (stats.status === 'safe_hours_hold') {
            resumeBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Send Now (Resume)';
        } else {
            resumeBtn.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
        }
    }

    if (stats.nextDelaySec) {
        const countdown = document.getElementById('liveDelayCountdown');
        if (countdown) countdown.innerText = `${stats.nextDelaySec}s`;
    }
}

function appendLiveLog(log) {
    const body = document.getElementById('liveLogBody');
    if (!body) return;

    const div = document.createElement('div');
    div.className = `log-entry ${log.type || 'info'}`;
    div.innerHTML = `<span class="log-time">[${log.timeStr || ''}]</span> ${escapeHtml(log.message)}`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
}

function clearLiveLogs() {
    const body = document.getElementById('liveLogBody');
    if (body) body.innerHTML = '';
}

async function pauseActiveCampaign() {
    await fetch('/api/campaigns/pause', { method: 'POST' });
    showToast('Broadcast paused.', 'info');
}

async function resumeActiveCampaign() {
    await fetch('/api/campaigns/resume', { method: 'POST' });
    showToast('Broadcast resumed.', 'success');
}

async function stopActiveCampaign() {
    if (confirm('Are you sure you want to cancel this running broadcast?')) {
        await fetch('/api/campaigns/stop', { method: 'POST' });
        showToast('Broadcast cancelled.', 'error');
    }
}

function openNewCampaignWizard() {
    switchView('campaign');
    document.getElementById('campaignBuilderCard').scrollIntoView({ behavior: 'smooth' });
}

function renderCampaignsTable() {
    const tbody = document.getElementById('dashboardCampaignsTable');
    if (!tbody) return;

    if (!appState.campaigns || appState.campaigns.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 28px;"><i class="fa-solid fa-bullhorn" style="font-size: 1.6rem; opacity: 0.35; margin-bottom: 8px;"></i><p>No past campaigns found. Click "New Campaign" to launch one!</p></td></tr>`;
        return;
    }

    let html = '';
    appState.campaigns.slice(0, 8).forEach(camp => {
        let dateStr = 'Recent';
        try {
            if (camp.createdAt) dateStr = new Date(camp.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch (e) {}

        let statusBadge = `<span class="status-pill">${camp.status || 'Draft'}</span>`;
        if (camp.status === 'completed') {
            statusBadge = `<span class="status-pill success"><i class="fa-solid fa-circle-check"></i> Completed</span>`;
        } else if (camp.status === 'running') {
            statusBadge = `<span class="status-pill running" style="background: rgba(56, 229, 77, 0.15); color: var(--accent-lime);"><i class="fa-solid fa-circle-notch fa-spin"></i> Active</span>`;
        } else if (camp.status === 'safe_hours_hold') {
            statusBadge = `<span class="status-pill warning" style="background: rgba(245, 158, 11, 0.15); color: var(--accent-amber);"><i class="fa-solid fa-moon"></i> Night Hold</span>`;
        } else if (camp.status === 'stopped') {
            statusBadge = `<span class="status-pill" style="background: rgba(239, 68, 68, 0.12); color: #f87171;"><i class="fa-solid fa-circle-stop"></i> Stopped</span>`;
        } else if (camp.status === 'paused') {
            statusBadge = `<span class="status-pill warning" style="background: rgba(245, 158, 11, 0.15); color: var(--accent-amber);"><i class="fa-solid fa-circle-pause"></i> Paused</span>`;
        }

        const totalRecipients = camp.recipients ? camp.recipients.length : (camp.total || 0);
        const delivered = camp.sentCount !== undefined ? camp.sentCount : totalRecipients;

        html += `
            <tr>
                <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <i class="fa-solid fa-paper-plane" style="color: var(--accent-lime); font-size: 0.85rem;"></i>
                        <strong style="color: #fff; font-size: 0.88rem;">${escapeHtml(camp.name)}</strong>
                    </div>
                </td>
                <td style="font-family: var(--font-mono); font-size: 0.82rem;">${totalRecipients} clients</td>
                <td style="font-family: var(--font-mono); font-size: 0.82rem; color: var(--accent-lime);">${delivered} / ${totalRecipients}</td>
                <td>${statusBadge}</td>
                <td style="color: var(--text-muted); font-size: 0.78rem;">${dateStr}</td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}

// AUTO-REPLY ASSISTANT
function renderAutoRepliesGrid() {
    const grid = document.getElementById('autoRepliesGrid');
    if (!grid) return;

    let html = '';
    appState.autoReplies.forEach((rule, idx) => {
        const isChecked = rule.enabled ? 'checked' : '';
        const keywordsBadges = rule.keywords.map(k => `<span class="keyword-tag">${escapeHtml(k)}</span>`).join(' ');

        html += `
            <div class="rule-card">
                <div class="rule-top">
                    <strong style="color: #fff; font-size: 0.95rem;">${escapeHtml(rule.name)}</strong>
                    <label class="switch">
                        <input type="checkbox" ${isChecked} onchange="toggleRuleEnabled(${idx}, this.checked)">
                        <span class="slider round"></span>
                    </label>
                </div>
                <div class="rule-keywords-list">
                    ${keywordsBadges}
                </div>
                <div class="rule-response-preview">
                    ${escapeHtml(rule.replyText)}
                </div>
            </div>
        `;
    });
    grid.innerHTML = html;
}

async function toggleRuleEnabled(index, enabled) {
    appState.autoReplies[index].enabled = enabled;
    await saveAutoRepliesToServer();
    showToast(`Rule ${enabled ? 'enabled' : 'disabled'}.`, 'info');
}

async function toggleAutoReplyMaster(enabled) {
    appState.settings.autoReplyEnabled = enabled;
    await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appState.settings)
    });
    showToast(`Auto-Reply Assistant ${enabled ? 'activated' : 'deactivated'}.`, 'info');
}

function openNewRuleModal() {
    document.getElementById('ruleModalTitle').innerHTML = '<i class="fa-solid fa-robot" style="color: var(--accent-lime);"></i> Add New Auto-Reply Rule';
    document.getElementById('editRuleId').value = '';
    document.getElementById('ruleNameInput').value = '';
    document.getElementById('ruleKeywordsInput').value = '';
    document.getElementById('ruleReplyTextInput').value = '';
    document.getElementById('ruleModal').classList.add('active');
}

function closeRuleModal() {
    document.getElementById('ruleModal').classList.remove('active');
}

async function handleSaveRule(e) {
    e.preventDefault();
    const name = document.getElementById('ruleNameInput').value.trim();
    const keywordsRaw = document.getElementById('ruleKeywordsInput').value.trim();
    const replyText = document.getElementById('ruleReplyTextInput').value.trim();

    const keywords = keywordsRaw.split(/[,]+/).map(k => k.trim()).filter(Boolean);

    const newRule = {
        id: 'rule-' + Date.now(),
        name,
        keywords,
        matchType: 'contains',
        replyText,
        enabled: true,
        mediaUrl: null
    };

    appState.autoReplies.push(newRule);
    await saveAutoRepliesToServer();
    closeRuleModal();
    renderAutoRepliesGrid();
    showToast(`Rule "${name}" added successfully!`, 'success');
}

async function saveAutoRepliesToServer() {
    await fetch('/api/autoreplies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appState.autoReplies)
    });
}

function setContactStatusFilter(status) {
    currentContactStatusFilter = status;
    document.querySelectorAll('.crm-chip').forEach(chip => chip.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');
    renderContactsTable();
}

// CONTACTS & CRM
function renderContactsTable() {
    const tbody = document.getElementById('contactsTableBody');
    if (!tbody) return;
    const filter = (document.getElementById('contactFilterInput')?.value || '').toLowerCase();

    // Compute CRM Ribbon Metrics
    const totalLeads = appState.contacts.length;
    let repliedLeads = 0;
    let contactedLeads = 0;
    let optOutLeads = 0;

    appState.contacts.forEach(c => {
        const s = (c.status || '').toLowerCase();
        if (s.includes('replied') || s.includes('inquiry')) repliedLeads++;
        if (s.includes('contacted') || s.includes('campaign') || s.includes('sent') || c.lastCampaign) contactedLeads++;
        if (s.includes('opt') || s.includes('unsub') || s.includes('stop')) optOutLeads++;
    });

    // Also include live chat replies
    Object.values(appState.chats).forEach(chat => {
        if (chat.messages && chat.messages.some(m => !m.fromMe)) {
            repliedLeads++;
        }
    });

    const crmTotal = document.getElementById('crmTotalCount');
    const crmReplied = document.getElementById('crmRepliedCount');
    const crmContacted = document.getElementById('crmContactedCount');
    const crmOptOut = document.getElementById('crmOptOutCount');

    if (crmTotal) crmTotal.innerText = totalLeads;
    if (crmReplied) crmReplied.innerText = repliedLeads;
    if (crmContacted) crmContacted.innerText = contactedLeads || totalLeads;
    if (crmOptOut) crmOptOut.innerText = optOutLeads;

    // Filter contacts
    let filtered = appState.contacts.filter(c => {
        const matchesQuery = (c.name || '').toLowerCase().includes(filter) || (c.phone || '').includes(filter) || (c.lastCampaign || '').toLowerCase().includes(filter);
        if (!matchesQuery) return false;

        const s = (c.status || '').toLowerCase();
        if (currentContactStatusFilter === 'replied') {
            return s.includes('replied') || s.includes('inquiry');
        } else if (currentContactStatusFilter === 'saved') {
            return s.includes('manual') || s.includes('saved') || s.includes('vip') || s === 'active lead';
        } else if (currentContactStatusFilter === 'opted_out') {
            return s.includes('opt') || s.includes('unsub') || s.includes('stop');
        }
        return true;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 32px;"><i class="fa-solid fa-users-slash" style="font-size: 1.8rem; opacity: 0.4; margin-bottom: 8px;"></i><p>No client leads found matching your criteria.</p></td></tr>`;
        return;
    }

    let html = '';
    filtered.forEach(c => {
        const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : 'Active';
        const initial = (c.name || 'C')[0].toUpperCase();
        const bgGrad = getAvatarGradient(c.phone || c.name);
        const isReplied = (c.status || '').toLowerCase().includes('replied');
        const statusBadge = isReplied 
            ? `<span class="status-pill warning" style="background: rgba(245, 158, 11, 0.15); color: var(--accent-amber);"><i class="fa-solid fa-fire"></i> Replied</span>` 
            : `<span class="status-pill success"><i class="fa-solid fa-circle-check"></i> ${c.status || 'Active Lead'}</span>`;

        html += `
            <tr>
                <td>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div class="client-avatar" style="width: 32px; height: 32px; font-size: 0.8rem; background: ${bgGrad}; color: #07090b;">${initial}</div>
                        <div>
                            <strong style="color: #fff; font-size: 0.88rem;">${escapeHtml(c.name || 'Valued Client')}</strong>
                        </div>
                    </div>
                </td>
                <td style="font-family: var(--font-mono); font-size: 0.82rem; color: #cbd5e1;">+${c.phone}</td>
                <td>${statusBadge}</td>
                <td style="color: var(--text-secondary); font-size: 0.8rem;"><i class="fa-solid fa-bullhorn" style="font-size: 0.72rem; opacity: 0.6;"></i> ${escapeHtml(c.lastCampaign || c.source || 'Direct Outreach')}</td>
                <td style="color: var(--text-muted); font-size: 0.76rem;">${dateStr}</td>
                <td style="text-align: right;">
                    <div style="display: flex; justify-content: flex-end; gap: 6px;">
                        <button class="pill-action-btn primary" style="padding: 4px 12px; font-size: 0.72rem;" onclick="startDirectChat('${c.phone}@s.whatsapp.net')" title="Start WhatsApp 1-on-1 Chat">
                            <i class="fa-brands fa-whatsapp"></i> Chat
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}

async function saveActiveContact() {
    if (!appState.activeChatJid) return;
    const chat = appState.chats[appState.activeChatJid];
    if (!chat) return;

    let phone = chat.phone || (chat.jid.endsWith('@s.whatsapp.net') ? chat.jid.split('@')[0] : '');
    const name = chat.name || 'WhatsApp Client';

    if (!phone) {
        showToast('Cannot save contact without valid phone number.', 'error');
        return;
    }

    try {
        const res = await fetch('/api/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone, status: 'saved_crm' })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Saved ${name} (+${phone}) to CRM Leads!`, 'success');
            loadAllData();
        }
    } catch (err) {
        showToast('Error saving contact: ' + err.message, 'error');
    }
}

function startDirectChat(jid) {
    if (!appState.chats[jid]) {
        const phone = jid.split('@')[0];
        const contact = appState.contacts.find(c => c.phone === phone);
        appState.chats[jid] = {
            jid,
            name: contact?.name || phone,
            unreadCount: 0,
            lastMessage: '',
            lastTimestamp: Date.now(),
            messages: []
        };
        renderConversationsList();
    }
    switchView('inbox');
    selectConversation(jid);
}

function openAddContactModal() {
    document.getElementById('addContactModal').classList.add('active');
}

function closeAddContactModal() {
    document.getElementById('addContactModal').classList.remove('active');
}

async function handleAddSingleContact(e) {
    e.preventDefault();
    const name = document.getElementById('newContactName').value.trim();
    let phone = document.getElementById('newContactPhone').value.trim().replace(/[^0-9]/g, '');

    if (phone.startsWith('0') && phone.length === 10) phone = '255' + phone.substring(1);
    else if (phone.length === 9 && (phone.startsWith('6') || phone.startsWith('7'))) phone = '255' + phone;

    try {
        const res = await fetch('/api/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone, status: 'manual_lead' })
        });
        const data = await res.json();
        if (data.success) {
            closeAddContactModal();
            loadAllData();
            showToast(`Added lead: ${name} (+${phone})`, 'success');
        }
    } catch (err) {
        showToast('Error adding contact: ' + err.message, 'error');
    }
}

function exportContactsCSV() {
    if (appState.contacts.length === 0) {
        showToast('No contact leads to export.', 'error');
        return;
    }
    let csv = 'Phone,Name,Status,LastCampaign,CreatedAt\n';
    appState.contacts.forEach(c => {
        csv += `"${c.phone}","${c.name || ''}","${c.status || ''}","${c.lastCampaign || ''}","${c.createdAt || ''}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `elevatestore_leads_${Date.now()}.csv`;
    a.click();
    showToast('Exported CSV file successfully!', 'success');
}

// SETTINGS
function updateSafeHoursSettingsStatus() {
    const badge = document.getElementById('settingsSafeHoursStatusBadge');
    if (!badge) return;

    const enabled = document.getElementById('settingSafeHoursEnabled')?.checked;
    if (!enabled) {
        badge.innerHTML = '<span style="color: var(--text-muted);"><i class="fa-solid fa-circle-xmark"></i> Safe Hours Guard Disabled</span>';
        return;
    }

    const start = document.getElementById('settingSafeHoursStart')?.value || '08:00';
    const end = document.getElementById('settingSafeHoursEnd')?.value || '21:00';

    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);

    const startTotal = (isNaN(startH) ? 8 : startH) * 60 + (isNaN(startM) ? 0 : startM);
    const endTotal = (isNaN(endH) ? 21 : endH) * 60 + (isNaN(endM) ? 0 : endM);

    let isSafe = false;
    if (startTotal <= endTotal) {
        isSafe = currentMins >= startTotal && currentMins <= endTotal;
    } else {
        isSafe = currentMins >= startTotal || currentMins <= endTotal;
    }

    if (isSafe) {
        badge.innerHTML = `<span style="color: var(--accent-lime);"><i class="fa-solid fa-sun"></i> Active Safe Window (${start} - ${end})</span>`;
    } else {
        badge.innerHTML = `<span style="color: var(--accent-amber);"><i class="fa-solid fa-moon"></i> Night Protection Active (Auto-queues until ${start})</span>`;
    }
}

function populateSettingsForm() {
    const nameInput = document.getElementById('settingStoreName');
    if (nameInput) nameInput.value = appState.settings.storeName || 'ELEVATESTORE';
    const phoneInput = document.getElementById('settingPhone');
    if (phoneInput) phoneInput.value = appState.settings.phone || '';
    const minDelay = document.getElementById('settingMinDelay');
    if (minDelay) minDelay.value = appState.settings.minDelaySeconds || 15;
    const maxDelay = document.getElementById('settingMaxDelay');
    if (maxDelay) maxDelay.value = appState.settings.maxDelaySeconds || 45;

    // Safe Hours
    const safeHoursCheck = document.getElementById('settingSafeHoursEnabled');
    if (safeHoursCheck) safeHoursCheck.checked = appState.settings.safeHoursEnabled !== false;
    const safeStart = document.getElementById('settingSafeHoursStart');
    if (safeStart) safeStart.value = appState.settings.safeHoursStart || '08:00';
    const safeEnd = document.getElementById('settingSafeHoursEnd');
    if (safeEnd) safeEnd.value = appState.settings.safeHoursEnd || '21:00';

    // Typing Simulation
    const typingCheck = document.getElementById('settingSimulateTyping');
    if (typingCheck) typingCheck.checked = appState.settings.simulateTyping !== false;
    const typingSpeed = document.getElementById('settingTypingSpeed');
    if (typingSpeed) {
        typingSpeed.value = appState.settings.typingSpeedCharsPerSec || 35;
        const lbl = document.getElementById('lblTypingSpeed');
        if (lbl) lbl.innerText = typingSpeed.value;
    }

    updateSafeHoursSettingsStatus();
    checkSafeHoursWindow();
}

async function handleSaveSettings(e) {
    e.preventDefault();
    appState.settings.storeName = document.getElementById('settingStoreName').value.trim();
    appState.settings.phone = document.getElementById('settingPhone').value.trim();
    appState.settings.minDelaySeconds = Number(document.getElementById('settingMinDelay').value);
    appState.settings.maxDelaySeconds = Number(document.getElementById('settingMaxDelay').value);
    appState.settings.soundNotifications = document.getElementById('settingSound').value === 'true';

    // Anti-Ban Safeguards
    appState.settings.safeHoursEnabled = document.getElementById('settingSafeHoursEnabled').checked;
    appState.settings.safeHoursStart = document.getElementById('settingSafeHoursStart').value || '08:00';
    appState.settings.safeHoursEnd = document.getElementById('settingSafeHoursEnd').value || '21:00';
    appState.settings.simulateTyping = document.getElementById('settingSimulateTyping').checked;
    appState.settings.typingSpeedCharsPerSec = Number(document.getElementById('settingTypingSpeed').value) || 35;

    await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appState.settings)
    });

    updateSafeHoursSettingsStatus();
    checkSafeHoursWindow();
    showToast('Anti-ban & store settings saved successfully!', 'success');
}

// Formatting Helpers
function formatChatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatMsgTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Edit Active Contact Name & Phone Handlers
function openEditActiveContactModal() {
    if (!appState.activeChatJid) return;
    const chat = appState.chats[appState.activeChatJid] || {};
    const nameInput = document.getElementById('editActiveContactName');
    const phoneInput = document.getElementById('editActiveContactPhone');

    if (nameInput) nameInput.value = chat.name || '';
    if (phoneInput) phoneInput.value = chat.phone || (chat.jid?.endsWith('@s.whatsapp.net') ? chat.jid.split('@')[0] : '');

    const modal = document.getElementById('editContactModal');
    if (modal) modal.classList.add('active');
}

function closeEditActiveContactModal() {
    const modal = document.getElementById('editContactModal');
    if (modal) modal.classList.remove('active');
}

async function handleSaveActiveContactDetails(e) {
    e.preventDefault();
    if (!appState.activeChatJid) return;

    const name = document.getElementById('editActiveContactName').value.trim();
    let phone = document.getElementById('editActiveContactPhone').value.trim().replace(/[^0-9]/g, '');

    if (phone) {
        if (phone.startsWith('0') && phone.length === 10) phone = '255' + phone.substring(1);
        else if (phone.length === 9 && (phone.startsWith('6') || phone.startsWith('7'))) phone = '255' + phone;
    }

    try {
        const res = await fetch('/api/chats/update_contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jid: appState.activeChatJid,
                name: name,
                phone: phone
            })
        });

        const data = await res.json();
        if (data.success) {
            if (appState.chats[appState.activeChatJid]) {
                if (name) appState.chats[appState.activeChatJid].name = name;
                if (phone) appState.chats[appState.activeChatJid].phone = phone;
            }
            closeEditActiveContactModal();
            selectConversation(appState.activeChatJid);
            loadAllData();
            showToast('Contact details updated successfully!', 'success');
        }
    } catch (err) {
        showToast('Error updating contact: ' + err.message, 'error');
    }
}
