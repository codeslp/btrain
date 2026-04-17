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

function _getRepoNames() {
    return typeof window.getRepoNames === 'function' ? window.getRepoNames() : [];
}

function _getRepoForChannel(name) {
    return typeof window.getRepoForChannel === 'function' ? window.getRepoForChannel(name) : '';
}

function _getActiveRepo() {
    return _getRepoForChannel(window.activeChannel);
}

function _isMultiRepoMode() {
    return _getRepoNames().length > 1;
}

function _getRepoAccent(repoName, index = 0) {
    const key = (repoName || '').toLowerCase();
    if (key.includes('btrain')) return '#24c8ff';
    if (key.includes('cgraph')) return '#ff5cd7';
    if (key.includes('mech')) return '#ffb84d';
    const palette = ['#24c8ff', '#ff5cd7', '#ffb84d', '#72e6a6', '#8b7dff', '#ff8a63'];
    return palette[index % palette.length];
}

function _applyRepoAccent(el, repoName, index = 0) {
    if (!el || !el.style || typeof el.style.setProperty !== 'function') return;
    el.style.setProperty('--repo-accent', _getRepoAccent(repoName, index));
}

function _getRepoSummary(repoName) {
    const repos = (window.btrainLanes && Array.isArray(window.btrainLanes.repos)) ? window.btrainLanes.repos : [];
    const repoIndex = repos.findIndex((entry) => entry && entry.name === repoName);
    const repo = repoIndex >= 0 ? repos[repoIndex] : null;
    const lanes = repo && Array.isArray(repo.lanes) ? repo.lanes : [];
    const activeCount = lanes.filter((lane) => {
        const status = lane.status || '';
        return status && status !== 'idle' && status !== 'resolved';
    }).length;
    const agentEntries = repo
        ? Object.entries(window.agentConfig || {})
            .filter(([, cfg]) => cfg.repo === repo.path && cfg.state !== 'pending')
            .sort(([, a], [, b]) => {
                const aLabel = (a.label || '').toLowerCase();
                const bLabel = (b.label || '').toLowerCase();
                return aLabel.localeCompare(bLabel);
            })
            .map(([name, cfg]) => {
                const label = (cfg.label || name).trim();
                const compact = label.length <= 12 ? label : _getAgentIdentity(name).short;
                return { name, label, compact };
            })
        : [];
    const agentCount = agentEntries.length;
    const visibleAgents = agentEntries.slice(0, 2).map((entry) => entry.compact);
    if (agentEntries.length > 2) visibleAgents.push('+' + (agentEntries.length - 2));
    return {
        repoIndex,
        activeCount,
        agentCount,
        agentDisplay: visibleAgents.join(' · ') || 'no agents',
        agentTitle: agentEntries.map((entry) => entry.label).join(', ') || 'No agents assigned',
    };
}

function _ensureRepoTabsContainer() {
    const bar = document.getElementById('lane-pills-bar');
    if (!bar) return null;

    let container = document.getElementById('repo-tabs');
    if (!container) {
        container = document.createElement('div');
        container.id = 'repo-tabs';
        container.className = 'repo-tabs';
        const laneTabs = document.getElementById('lane-tabs');
        if (laneTabs) {
            bar.insertBefore(container, laneTabs);
        } else {
            bar.prepend(container);
        }
    }
    return container;
}

function _formatRepoBadge(repoName) {
    return repoName.slice(0, 3).toUpperCase();
}

function _formatChannelLabel(name) {
    const repoName = _getRepoForChannel(name);
    if (!repoName) return '# ' + name;
    const suffix = name.split('/').slice(1).join('/').toUpperCase();
    return '# ' + _formatRepoBadge(repoName) + '/' + suffix;
}

function _getVisibleUserChannels() {
    const activeRepo = _getActiveRepo();
    const baseChannels = window.channelList || [];
    if (!activeRepo) {
        return baseChannels.filter((name) => !_getRepoForChannel(name));
    }

    const channels = [`${activeRepo}/agents`];
    for (const name of baseChannels) {
        if (_getRepoForChannel(name) === activeRepo && !channels.includes(name)) {
            channels.push(name);
        }
    }
    return channels;
}

function renderRepoTabs() {
    const container = _ensureRepoTabsContainer();
    if (!container) return;
    const bar = document.getElementById('lane-pills-bar');

    const repoNames = _getRepoNames();
    if (repoNames.length <= 1) {
        container.innerHTML = '';
        container.style.display = 'none';
        if (bar) bar.classList.remove('lane-pills-bar-multi');
        return;
    }

    container.style.display = '';
    container.innerHTML = '';
    if (bar) bar.classList.add('lane-pills-bar-multi');
    const activeRepo = _getActiveRepo();

    const allBtn = document.createElement('button');
    allBtn.className = 'repo-tab repo-tab-all' + (!activeRepo ? ' active' : '');
    allBtn.innerHTML = `
        <span class="repo-tab-head">
            <span class="repo-tab-label">ALL</span>
            <span class="repo-tab-meta">all repos</span>
        </span>
    `;
    allBtn.onclick = () => switchChannel('general');
    container.appendChild(allBtn);

    for (const repoName of repoNames) {
        const { repoIndex, activeCount, agentCount, agentDisplay, agentTitle } = _getRepoSummary(repoName);
        const btn = document.createElement('button');
        btn.className = 'repo-tab' + (activeRepo === repoName ? ' active' : '');
        btn.dataset.repo = repoName;
        btn.title = `${repoName} — ${agentTitle}`;
        _applyRepoAccent(btn, repoName, repoIndex >= 0 ? repoIndex : 0);
        btn.innerHTML = `
            <span class="repo-tab-head">
                <span class="repo-tab-label">${_formatRepoBadge(repoName)}</span>
                <span class="repo-tab-meta">${activeCount}A · ${agentCount}G</span>
            </span>
            <span class="repo-tab-agents">${escapeHtml(agentDisplay)}</span>
        `;
        btn.onclick = () => switchChannel(`${repoName}/agents`);
        container.appendChild(btn);
    }
}

function _createLanePill(lid, lane, idx) {
    const status = lane.status || 'idle';
    const isActive = lid === window.activeChannel;
    const animClass = _LANE_STATUS_ANIM[status] || 'status-idle';

    const pill = document.createElement('button');
    pill.className = 'lane-pill ' + animClass + (isActive ? ' active' : '');
    pill.dataset.channel = lid;
    pill.style.animationDelay = (idx * 0.1) + 's';
    pill.title = status.toUpperCase();

    const box = document.createElement('div');
    box.className = 'lane-box ' + status;
    const bareLane = (lane._laneId || lid).toUpperCase();
    const repoPrefix = lane._repo ? lane._repo.slice(0, 3).toUpperCase() + '/' : '';
    box.textContent = repoPrefix + bareLane;
    if (lane._repo) pill.title = lane._repo + ' — ' + status.toUpperCase();
    pill.appendChild(box);

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

    if (lane.repurposeReady) {
        const badge = document.createElement('span');
        badge.className = 'lane-repurpose-badge';
        badge.textContent = 'R';
        badge.title = 'Repurpose ready' + (lane.repurposeReason ? ': ' + lane.repurposeReason : '');
        pill.appendChild(badge);
    }

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

    return pill;
}

function _renderRepoLaneGroups(laneContainer, laneChannels, laneMap) {
    const activeRepo = _getActiveRepo();
    const repoNames = _getRepoNames().filter((repoName) => !activeRepo || repoName === activeRepo);

    laneContainer.classList.add('lane-tabs-grouped');
    let renderedGroups = 0;

    repoNames.forEach((repoName, repoIndex) => {
        const repoLaneChannels = laneChannels.filter((name) => _getRepoForChannel(name) === repoName);
        if (repoLaneChannels.length === 0) return;

        const summary = _getRepoSummary(repoName);
        const group = document.createElement('section');
        group.className = 'lane-repo-group';
        group.dataset.repo = repoName;
        _applyRepoAccent(group, repoName, summary.repoIndex >= 0 ? summary.repoIndex : repoIndex);

        const head = document.createElement('div');
        head.className = 'lane-repo-group-head';
        head.innerHTML = `
            <span class="lane-repo-group-label">${_formatRepoBadge(repoName)}</span>
            <span class="lane-repo-group-meta">${summary.activeCount} active</span>
        `;
        group.appendChild(head);

        const pills = document.createElement('div');
        pills.className = 'lane-repo-group-pills';
        repoLaneChannels.forEach((lid, idx) => {
            const lane = laneMap[lid] || {};
            pills.appendChild(_createLanePill(lid, lane, idx));
        });
        group.appendChild(pills);
        laneContainer.appendChild(group);
        renderedGroups += 1;
    });

    return renderedGroups;
}

function renderLaneHeader() {
    const container = document.getElementById('lane-header');
    if (!container) return;

    const lid = window.activeChannel;
    const laneData = window.btrainLanes || {};
    const lanes = laneData.lanes || [];
    // Match by bare lane ID or repo-qualified channel ID
    const lane = lanes.find(l => l._laneId === lid || (l._repo && l._repo + '/' + l._laneId === lid));

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
    renderRepoTabs();

    // Preserve inline create input if it exists
    const existingCreate = container.querySelector('.channel-inline-create');
    container.innerHTML = '';

    // --- Lane tabs (system-managed, before user channels) ---
    const laneContainer = document.getElementById('lane-tabs');
    if (laneContainer) {
        laneContainer.innerHTML = '';
        laneContainer.classList.remove('lane-tabs-grouped');
        const activeRepo = _getActiveRepo();
        const laneChannels = (window.laneChannels || []).filter((name) => !activeRepo || _getRepoForChannel(name) === activeRepo);
        const laneData = window.btrainLanes || {};
        const lanes = laneData.lanes || [];
        const laneMap = {};
        for (const l of lanes) {
            laneMap[l._laneId] = l;
            // Also key by repo-qualified ID for multi-repo lookup
            if (l._repo) laneMap[l._repo + '/' + l._laneId] = l;
        }

        if (laneChannels.length > 0) {
            if (_isMultiRepoMode()) {
                _renderRepoLaneGroups(laneContainer, laneChannels, laneMap);
            } else {
                for (let idx = 0; idx < laneChannels.length; idx++) {
                    const lid = laneChannels[idx];
                    const lane = laneMap[lid] || {};
                    laneContainer.appendChild(_createLanePill(lid, lane, idx));
                }
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
    const visibleChannels = _getVisibleUserChannels();
    for (const name of visibleChannels) {
        const tab = document.createElement('button');
        tab.className = 'channel-tab' + (name === window.activeChannel ? ' active' : '');
        tab.dataset.channel = name;

        const label = document.createElement('span');
        label.className = 'channel-tab-label';
        label.textContent = _formatChannelLabel(name);
        tab.appendChild(label);

        const unread = window.channelUnread[name] || 0;
        if (unread > 0 && name !== window.activeChannel) {
            const dot = document.createElement('span');
            dot.className = 'channel-unread-dot';
            dot.textContent = unread > 99 ? '99+' : unread;
            tab.appendChild(dot);
        }

        // Edit + delete icons for non-general tabs (visible on hover via CSS)
        if ((window.channelList || []).includes(name) && name !== 'general') {
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
    if (existingCreate && !_getActiveRepo()) {
        container.appendChild(existingCreate);
    } else if (existingCreate) {
        existingCreate.remove();
    }

    // Update add button disabled state
    const addBtn = document.getElementById('channel-add-btn');
    if (addBtn) {
        const repoScoped = Boolean(_getActiveRepo());
        addBtn.classList.toggle('disabled', repoScoped || window.channelList.length >= 8);
        addBtn.style.display = repoScoped ? 'none' : '';
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
    if (window.renderLanesPanel) window.renderLanesPanel();
    if (window.renderLaneHeader) window.renderLaneHeader();
    if (window.buildStatusPills) window.buildStatusPills();
    if (window.buildMentionToggles) window.buildMentionToggles();
    if (window.updateRepoScopeTitle) window.updateRepoScopeTitle();
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
    if (_getActiveRepo()) return;
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
