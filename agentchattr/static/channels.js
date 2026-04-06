// channels.js -- Channel tabs, switching, filtering, CRUD
// Extracted from chat.js PR 4.  Reads shared state via window.* bridges.

'use strict';

// ---------------------------------------------------------------------------
// State (local to channels)
// ---------------------------------------------------------------------------

const _channelScrollMsg = {};  // channel name -> message ID at top of viewport

// Lane status → animation class (mirrors dashboard indicator-pill)
const _LANE_STATUS_ANIM = {
    'in-progress':       'status-in-progress',
    'needs-review':      'status-needs-review',
    'changes-requested': 'status-changes-requested',
    'repair-needed':     'status-repair-needed',
    'resolved':          'status-resolved',
    'idle':              'status-idle',
};

// Hot seat resolution (mirrors dashboard HOT_SEAT_RESOLVERS)
function _resolveHotSeat(lane) {
    const status = lane.status || 'idle';
    if (status === 'in-progress') return lane.owner || '';
    if (status === 'needs-review') return lane.reviewer || '';
    if (status === 'changes-requested') return lane.owner || '';
    if (status === 'repair-needed') return lane.repairOwner || lane.owner || '';
    return '';
}

// Agent identity → short name + neon color (mirrors dashboard getAgentIdentity)
function _getAgentIdentity(name) {
    if (!name) return { short: '---', color: '#666', chat: '' };
    const n = name.toLowerCase();
    if (n.includes('codex') || n.includes('gpt')) return { short: 'CDX', color: '#00f0ff', chat: 'codex' };
    if (n.includes('opus') || n.includes('claude')) return { short: 'CLD', color: '#ff00ff', chat: 'claude' };
    if (n.includes('gemini')) return { short: 'GEM', color: '#ffb300', chat: 'gemini' };
    if (n.includes('antigravity') || n.includes('anti')) return { short: 'ANTI', color: '#b366ff', chat: 'antigravity' };
    return { short: name.substring(0, 3).toUpperCase(), color: '#e6edf3', chat: n.split(' ')[0] };
}

// Expose for chat.js lane header
window._resolveHotSeat = _resolveHotSeat;
window._getAgentIdentity = _getAgentIdentity;

function renderLaneHeader() {
    const container = document.getElementById('lane-header');
    if (!container) return;

    const lid = window.activeChannel;
    const laneData = window.btrainLanes || {};
    const lanes = laneData.lanes || [];
    const lane = lanes.find(l => l._laneId === lid);

    if (!lane || lid === 'general') {
        container.classList.add('hidden');
        return;
    }

    const status = lane.status || 'idle';
    const ownerId = _getAgentIdentity(lane.owner);
    const reviewerId = _getAgentIdentity(lane.reviewer);
    
    // Status colors (mirrors shared-tokens.css classes)
    const statusClass = _LANE_STATUS_ANIM[status] || 'status-idle';
    
    container.innerHTML = `
        <div class="lh-top-row">
            <div class="lh-title-group">
                <div class="lh-lane-id">${lid.toUpperCase()}</div>
                <div class="lh-task" title="${escapeHtml(lane.task || '(no task)')}">${escapeHtml(lane.task || '(no task)')}</div>
            </div>
            <div class="lh-status-pill ${statusClass}">${status.replace(/-/g, ' ')}</div>
        </div>
        
        <div class="lh-meta-grid">
            <div class="lh-meta-item">
                <span class="lh-meta-label">Active Agent</span>
                <span class="lh-meta-value agent-name" style="color: ${ownerId.color}">
                    ${ownerId.short}
                </span>
            </div>
            <div class="lh-meta-item">
                <span class="lh-meta-label">Peer Reviewer</span>
                <span class="lh-meta-value agent-name" style="color: ${reviewerId.color}">
                    ${reviewerId.short}
                </span>
            </div>
            <div class="lh-meta-item" style="grid-column: span 2">
                <span class="lh-meta-label">Locked Files</span>
                <div class="lh-locks">
                    ${(lane.lockedFiles || []).length > 0 
                        ? lane.lockedFiles.map(f => `<span class="lh-lock-tag">${escapeHtml(f)}</span>`).join('')
                        : '<span class="lh-meta-value" style="color: var(--text-dim)">none</span>'}
                </div>
            </div>
        </div>

        <div class="lh-next-action">
            <span class="lh-next-label">Next Action</span>
            ${escapeHtml(lane.nextAction || 'Run btrain handoff for guidance.')}
        </div>

        <div class="lh-footer">
            <a href="#" class="lh-link" onclick="openPath('${escapeHtml(lane.handoffPath)}'); return false;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                handoff.md
            </a>
        </div>
    `;

    container.classList.remove('hidden');
}

window.renderLaneHeader = renderLaneHeader;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _getTopVisibleMsgId() {
    const scroll = document.getElementById('timeline');
    const container = document.getElementById('messages');
    if (!scroll || !container) return null;
    const rect = scroll.getBoundingClientRect();
    for (const el of container.children) {
        if (el.style.display === 'none' || !el.dataset.id) continue;
        const elRect = el.getBoundingClientRect();
        if (elRect.bottom > rect.top) return el.dataset.id;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderChannelTabs() {
    const container = document.getElementById('channel-tabs');
    if (!container) return;

    // Preserve inline create input if it exists
    const existingCreate = container.querySelector('.channel-inline-create');
    container.innerHTML = '';

    // --- Lane tabs (system-managed, before user channels) ---
    const laneContainer = document.getElementById('lane-tabs');
    if (laneContainer) {
        laneContainer.innerHTML = '';
        const laneChannels = window.laneChannels || [];
        const laneData = window.btrainLanes || {};
        const lanes = laneData.lanes || [];
        const laneMap = {};
        for (const l of lanes) laneMap[l._laneId] = l;

        if (laneChannels.length > 0) {
            for (let idx = 0; idx < laneChannels.length; idx++) {
                const lid = laneChannels[idx];
                const lane = laneMap[lid] || {};
                const status = lane.status || 'idle';
                const isActive = lid === window.activeChannel;
                const animClass = _LANE_STATUS_ANIM[status] || 'status-idle';

                // Mini card pill (mirrors dashboard indicator-pill)
                const pill = document.createElement('button');
                pill.className = 'lane-pill ' + animClass + (isActive ? ' active' : '');
                pill.dataset.channel = lid;
                pill.style.animationDelay = (idx * 0.1) + 's';
                pill.title = status.toUpperCase();

                // Colored lane box with letter
                const box = document.createElement('div');
                box.className = 'lane-box ' + status;
                box.textContent = lid.toUpperCase();
                pill.appendChild(box);

                // Hot seat agent label (color-coded like dashboard)
                const hotSeatName = _resolveHotSeat(lane);
                const hasHotSeat = hotSeatName && status !== 'resolved' && status !== 'idle';
                const identity = hasHotSeat ? _getAgentIdentity(hotSeatName) : { short: '---', color: 'var(--text-muted)' };

                const agentLabel = document.createElement('div');
                agentLabel.className = 'lane-pill-agent';
                agentLabel.textContent = identity.short;
                agentLabel.style.color = identity.color;
                if (hasHotSeat) {
                    pill.classList.add('has-hotseat');
                }
                pill.appendChild(agentLabel);

                // Repurpose-ready badge
                if (lane.repurposeReady) {
                    const badge = document.createElement('span');
                    badge.className = 'lane-repurpose-badge';
                    badge.textContent = 'R';
                    badge.title = 'Repurpose ready' + (lane.repurposeReason ? ': ' + lane.repurposeReason : '');
                    pill.appendChild(badge);
                }

                // Unread count
                const unread = window.channelUnread[lid] || 0;
                if (unread > 0 && !isActive) {
                    const badge = document.createElement('span');
                    badge.className = 'lane-pill-unread';
                    badge.textContent = unread > 99 ? '99+' : unread;
                    pill.appendChild(badge);
                }

                pill.onclick = () => {
                    document.querySelectorAll('.channel-tab.editing').forEach(t => t.classList.remove('editing'));
                    switchChannel(lid);
                };

                laneContainer.appendChild(pill);
            }
            // Show divider
            const divider = document.getElementById('lane-divider');
            if (divider) divider.style.display = '';
        } else {
            const divider = document.getElementById('lane-divider');
            if (divider) divider.style.display = 'none';
        }
    }

    // --- User channel tabs ---
    for (const name of window.channelList) {
        const tab = document.createElement('button');
        tab.className = 'channel-tab' + (name === window.activeChannel ? ' active' : '');
        tab.dataset.channel = name;

        const label = document.createElement('span');
        label.className = 'channel-tab-label';
        label.textContent = '# ' + name;
        tab.appendChild(label);

        const unread = window.channelUnread[name] || 0;
        if (unread > 0 && name !== window.activeChannel) {
            const dot = document.createElement('span');
            dot.className = 'channel-unread-dot';
            dot.textContent = unread > 99 ? '99+' : unread;
            tab.appendChild(dot);
        }

        // Edit + delete icons for non-general tabs (visible on hover via CSS)
        if (name !== 'general') {
            const actions = document.createElement('span');
            actions.className = 'channel-tab-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'ch-edit-btn';
            editBtn.title = 'Rename';
            editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
            editBtn.onclick = (e) => { e.stopPropagation(); showChannelRenameDialog(name); };
            actions.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'ch-delete-btn';
            delBtn.title = 'Delete';
            delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V3h4v1M5 4v8.5h6V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            delBtn.onclick = (e) => { e.stopPropagation(); deleteChannel(name); };
            actions.appendChild(delBtn);

            tab.appendChild(actions);
        }

        tab.onclick = (e) => {
            if (e.target.closest('.channel-tab-actions')) return;
            if (name === window.activeChannel) {
                // Second click on active tab -- toggle edit controls
                tab.classList.toggle('editing');
            } else {
                // Clear any editing state, switch channel
                document.querySelectorAll('.channel-tab.editing').forEach(t => t.classList.remove('editing'));
                switchChannel(name);
            }
        };

        container.appendChild(tab);
    }

    // Re-append inline create if it was open
    if (existingCreate) {
        container.appendChild(existingCreate);
    }

    // Update add button disabled state
    const addBtn = document.getElementById('channel-add-btn');
    if (addBtn) {
        addBtn.classList.toggle('disabled', window.channelList.length >= 8);
    }
}

// ---------------------------------------------------------------------------
// Switch / filter
// ---------------------------------------------------------------------------

function switchChannel(name) {
    if (name === window.activeChannel) return;
    // Save top-visible message ID for current channel
    const topId = _getTopVisibleMsgId();
    if (topId) _channelScrollMsg[window.activeChannel] = topId;
    window._setActiveChannel(name);
    window.channelUnread[name] = 0;
    localStorage.setItem('agentchattr-channel', name);
    filterMessagesByChannel();
    renderChannelTabs();
    if (window.renderLaneHeader) window.renderLaneHeader();
    Store.set('activeChannel', name);
    // Restore: scroll to saved message, or bottom if none saved
    const savedId = _channelScrollMsg[name];
    if (savedId) {
        const el = document.querySelector(`.message[data-id="${savedId}"]`);
        if (el) { el.scrollIntoView({ block: 'start' }); return; }
    }
    window.scrollToBottom();
}

function filterMessagesByChannel() {
    const container = document.getElementById('messages');
    if (!container) return;

    for (const el of container.children) {
        const ch = el.dataset.channel || 'general';
        el.style.display = ch === window.activeChannel ? '' : 'none';
    }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function showChannelCreateDialog() {
    if (window.channelList.length >= 8) return;
    const tabs = document.getElementById('channel-tabs');
    // Remove existing inline create if any
    tabs.querySelector('.channel-inline-create')?.remove();

    // Hide the + button while creating
    const addBtn = document.getElementById('channel-add-btn');
    if (addBtn) addBtn.style.display = 'none';

    const wrapper = document.createElement('div');
    wrapper.className = 'channel-inline-create';

    const prefix = document.createElement('span');
    prefix.className = 'channel-input-prefix';
    prefix.textContent = '#';
    wrapper.appendChild(prefix);

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = 'channel-name';
    wrapper.appendChild(input);

    const cleanup = () => { wrapper.remove(); if (addBtn) addBtn.style.display = ''; };

    const confirm = document.createElement('button');
    confirm.className = 'confirm-btn';
    confirm.innerHTML = '&#10003;';
    confirm.title = 'Create';
    confirm.onclick = () => { _submitInlineCreate(input, wrapper); if (addBtn) addBtn.style.display = ''; };
    wrapper.appendChild(confirm);

    const cancel = document.createElement('button');
    cancel.className = 'cancel-btn';
    cancel.innerHTML = '&#10005;';
    cancel.title = 'Cancel';
    cancel.onclick = cleanup;
    wrapper.appendChild(cancel);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _submitInlineCreate(input, wrapper); if (addBtn) addBtn.style.display = ''; }
        if (e.key === 'Escape') cleanup();
    });
    input.addEventListener('input', () => {
        input.value = input.value.toLowerCase().replace(/[^a-z0-9\-]/g, '');
    });

    tabs.appendChild(wrapper);
    input.focus();
}

function _submitInlineCreate(input, wrapper) {
    const name = input.value.trim().toLowerCase();
    if (!name || !/^[a-z0-9][a-z0-9\-]{0,19}$/.test(name)) return;
    if (window.channelList.includes(name)) { input.focus(); return; }
    window._setPendingChannelSwitch(name);
    window.ws.send(JSON.stringify({ type: 'channel_create', name }));
    wrapper.remove();
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

function showChannelRenameDialog(oldName) {
    const tabs = document.getElementById('channel-tabs');
    tabs.querySelector('.channel-inline-create')?.remove();

    // Find the tab being renamed so we can insert the input in its place
    const targetTab = tabs.querySelector(`.channel-tab[data-channel="${oldName}"]`);

    const wrapper = document.createElement('div');
    wrapper.className = 'channel-inline-create';

    const prefix = document.createElement('span');
    prefix.className = 'channel-input-prefix';
    prefix.textContent = '#';
    wrapper.appendChild(prefix);

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.value = oldName;
    wrapper.appendChild(input);

    const cleanup = () => {
        wrapper.remove();
        if (targetTab) targetTab.style.display = '';
    };

    const confirm = document.createElement('button');
    confirm.className = 'confirm-btn';
    confirm.innerHTML = '&#10003;';
    confirm.title = 'Rename';
    confirm.onclick = () => {
        const newName = input.value.trim().toLowerCase();
        if (!newName || !/^[a-z0-9][a-z0-9\-]{0,19}$/.test(newName)) return;
        if (newName !== oldName) {
            window.ws.send(JSON.stringify({ type: 'channel_rename', old_name: oldName, new_name: newName }));
            if (window.activeChannel === oldName) {
                window._setActiveChannel(newName);
                localStorage.setItem('agentchattr-channel', newName);
                Store.set('activeChannel', newName);
            }
        }
        cleanup();
    };
    wrapper.appendChild(confirm);

    const cancel = document.createElement('button');
    cancel.className = 'cancel-btn';
    cancel.innerHTML = '&#10005;';
    cancel.title = 'Cancel';
    cancel.onclick = cleanup;
    wrapper.appendChild(cancel);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirm.click(); }
        if (e.key === 'Escape') cleanup();
    });
    input.addEventListener('input', () => {
        input.value = input.value.toLowerCase().replace(/[^a-z0-9\-]/g, '');
    });

    // Insert inline next to the tab, hide the original tab
    if (targetTab) {
        targetTab.style.display = 'none';
        targetTab.insertAdjacentElement('afterend', wrapper);
    } else {
        tabs.appendChild(wrapper);
    }
    input.select();
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

function deleteChannel(name) {
    if (name === 'general') return;
    const tab = document.querySelector(`.channel-tab[data-channel="${name}"]`);
    if (!tab || tab.classList.contains('confirm-delete')) return;

    const label = tab.querySelector('.channel-tab-label');
    const actions = tab.querySelector('.channel-tab-actions');
    const originalText = label.textContent;
    const originalOnclick = tab.onclick;

    tab.classList.add('confirm-delete');
    tab.classList.remove('editing');
    label.textContent = `delete #${name}?`;
    if (actions) actions.style.display = 'none';

    const confirmBar = document.createElement('span');
    confirmBar.className = 'channel-delete-confirm';

    const tickBtn = document.createElement('button');
    tickBtn.className = 'ch-confirm-yes';
    tickBtn.title = 'Confirm delete';
    tickBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const crossBtn = document.createElement('button');
    crossBtn.className = 'ch-confirm-no';
    crossBtn.title = 'Cancel';
    crossBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    confirmBar.appendChild(tickBtn);
    confirmBar.appendChild(crossBtn);
    tab.appendChild(confirmBar);

    const revert = () => {
        tab.classList.remove('confirm-delete');
        label.textContent = originalText;
        if (actions) actions.style.display = '';
        confirmBar.remove();
        tab.onclick = originalOnclick;
        document.removeEventListener('click', outsideClick);
    };

    tickBtn.onclick = (e) => {
        e.stopPropagation();
        revert();
        window.ws.send(JSON.stringify({ type: 'channel_delete', name }));
        if (window.activeChannel === name) switchChannel('general');
    };

    crossBtn.onclick = (e) => {
        e.stopPropagation();
        revert();
    };

    tab.onclick = (e) => { e.stopPropagation(); };

    const outsideClick = (e) => {
        if (!tab.contains(e.target)) revert();
    };
    setTimeout(() => document.addEventListener('click', outsideClick), 0);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function _channelsInit() {
    _setupLanesGrip();
    // Restore collapsed state
    if (localStorage.getItem('lanes-panel-collapsed') === '1') {
        const panel = document.getElementById('lanes-panel');
        if (panel) panel.classList.add('collapsed');
    }
}

function _setupLanesGrip() {
    const grip = document.getElementById('lanes-grip');
    const panel = document.getElementById('lanes-panel');
    if (!grip || !panel) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        grip.classList.add('dragging');
        panel.style.transition = 'none';
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        // Grip is on right edge — dragging right increases width
        const delta = e.clientX - startX;
        const newWidth = Math.min(Math.max(startWidth + delta, 60), window.innerWidth * 0.5);
        panel.style.setProperty('--lanes-panel-w', newWidth + 'px');
        panel.style.width = newWidth + 'px';
        // Auto-collapse if dragged very narrow
        panel.classList.toggle('collapsed', newWidth <= 70);
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        grip.classList.remove('dragging');
        panel.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('lanes-panel-collapsed', panel.classList.contains('collapsed') ? '1' : '');
    });

    // Double-click grip to toggle collapse
    grip.addEventListener('dblclick', () => {
        if (window.toggleLanesPanel) window.toggleLanesPanel();
    });
}

// ---------------------------------------------------------------------------
// Window exports (for inline onclick in index.html and chat.js callers)
// ---------------------------------------------------------------------------

window.showChannelCreateDialog = showChannelCreateDialog;
window.switchChannel = switchChannel;
window.filterMessagesByChannel = filterMessagesByChannel;
window.renderChannelTabs = renderChannelTabs;
window.deleteChannel = deleteChannel;
window.showChannelRenameDialog = showChannelRenameDialog;
window.Channels = { init: _channelsInit };
