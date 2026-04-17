const http = require('http');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3333;

const HOT_SEAT_RESOLVERS = {
  'in-progress': ({ writer }) => writer,
  'needs-review': ({ reviewer }) => reviewer,
  'changes-requested': ({ writer }) => writer,
  'repair-needed': ({ repairOwner, writer }) => repairOwner || writer
};

const STATUS_CLASS_NAMES = {
  idle: 'status-idle',
  'in-progress': 'status-in-progress',
  'needs-review': 'status-needs-review',
  'changes-requested': 'status-changes-requested',
  'repair-needed': 'status-repair-needed',
  resolved: 'status-resolved'
};

function getActiveAgents() {
  try {
    const tomlPath = path.join(process.cwd(), '.btrain', 'project.toml');
    if (!fs.existsSync(tomlPath)) {
      return ['(Not found)'];
    }
    const content = fs.readFileSync(tomlPath, 'utf8');
    const match = content.match(/active\s*=\s*\[(.*?)\]/);
    if (match) {
      return match[1].split(',').map(s => s.replace(/['"]/g, '').trim());
    }
  } catch(e) {
    console.error(e);
  }
  return [];
}

function normalizeTextList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeParagraphLines(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function summarizeText(value) {
  return normalizeParagraphLines(value).join(' ');
}

function hasDelegationPacketData(packet) {
  if (!packet || typeof packet !== 'object') {
    return false;
  }

  return Boolean(
    summarizeText(packet.objective) ||
    summarizeText(packet.deliverable) ||
    normalizeTextList(packet.constraints).length > 0 ||
    normalizeTextList(packet.acceptance).length > 0 ||
    summarizeText(packet.budget) ||
    summarizeText(packet.doneWhen)
  );
}

function appendParagraphSection(lines, title, value) {
  const paragraphLines = normalizeParagraphLines(value);
  if (paragraphLines.length === 0) {
    return;
  }

  lines.push(`${title}:`, '', ...paragraphLines, '');
}

function appendBulletSection(lines, title, values) {
  const items = normalizeTextList(values);
  if (items.length === 0) {
    return;
  }

  lines.push(`${title}:`, '', ...items.map((item) => `- ${item}`), '');
}

function buildLaneFullText(lane) {
  const lockPaths = normalizeTextList(lane.lockPaths);
  const reasonTags = normalizeTextList(lane.reasonTags);
  const packet = lane.delegationPacket || {};
  const lines = [
    `Lane: ${lane._laneId || lane.lane || '(unknown)'}`,
    `Task: ${lane.task || '(no task)'}`,
    `Status: ${lane.status || 'idle'}`,
  ];

  if (lane.owner) {
    lines.push(`Writer: ${lane.owner}`);
  }
  if (lane.reviewer) {
    lines.push(`Reviewer: ${lane.reviewer}`);
  }
  if (lane.repairOwner) {
    lines.push(`Repair owner: ${lane.repairOwner}`);
  }
  if (lane.reasonCode) {
    lines.push(`Reason code: ${lane.reasonCode}`);
  }
  if (reasonTags.length > 0) {
    lines.push(`Reason tags: ${reasonTags.join(', ')}`);
  }
  if (lane.base) {
    lines.push(`Base: ${lane.base}`);
  }
  if (lockPaths.length > 0) {
    lines.push(`Locks: ${lockPaths.join(', ')}`);
  }
  if (lane.nextAction) {
    lines.push('');
    appendParagraphSection(lines, 'Next action', lane.nextAction);
  }
  if (hasDelegationPacketData(packet)) {
    lines.push('## Delegation Packet', '');
    appendParagraphSection(lines, 'Objective', packet.objective);
    appendParagraphSection(lines, 'Deliverable', packet.deliverable);
    appendBulletSection(lines, 'Constraints', packet.constraints);
    appendBulletSection(lines, 'Acceptance checks', packet.acceptance);
    appendParagraphSection(lines, 'Budget', packet.budget);
    appendParagraphSection(lines, 'Done when', packet.doneWhen);
  }

  while (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

function isBugLane(task, detailLines, status) {
  if (status === 'resolved') {
    return false;
  }

  const bugPattern = /\b(bug|issue)\b/i;
  return detailLines.some((value) => bugPattern.test(String(value || ''))) || bugPattern.test(task || '');
}

function toDashboardLane(lane) {
  const task = lane.task || '(no task)';
  const writer = lane.owner || '';
  const reviewer = lane.reviewer || '';
  const repairOwner = lane.repairOwner || '';
  const lockPaths = normalizeTextList(lane.lockPaths);
  const packet = lane.delegationPacket || {};
  const objective = summarizeText(packet.objective);
  const doneWhen = summarizeText(packet.doneWhen);
  const fullText = buildLaneFullText(lane);
  const detailLines = [
    task,
    lane.nextAction,
    lane.reasonCode,
    objective,
    summarizeText(packet.deliverable),
    summarizeText(packet.budget),
    doneWhen,
    ...normalizeTextList(packet.constraints),
    ...normalizeTextList(packet.acceptance),
  ];

  let hotSeat = 'Unassigned';
  const resolveHotSeat = HOT_SEAT_RESOLVERS[lane.status];
  if (resolveHotSeat) {
    hotSeat = resolveHotSeat({ writer, reviewer, repairOwner }) || 'Unassigned';
  }

  return {
    id: lane._laneId || lane.lane || '',
    status: lane.status || 'idle',
    desc: task,
    writer,
    reviewer,
    repairOwner,
    hotSeat,
    locks: lockPaths.join(', '),
    objective,
    doneWhen,
    fullText,
    isBug: isBugLane(task, detailLines, lane.status),
  };
}

function getBtrainStatus() {
  try {
    const raw = execFileSync('btrain', ['status', '--repo', '.', '--json'], { encoding: 'utf8' });
    const statuses = JSON.parse(raw);
    const repoStatus = Array.isArray(statuses) ? statuses[0] : null;
    const currentLanes = Array.isArray(repoStatus?.lanes) ? repoStatus.lanes.map(toDashboardLane) : [];
    return { lanes: currentLanes, activeAgents: getActiveAgents() };
  } catch (error) {
    console.error('Error fetching btrain status:', error);
    return { lanes: [], activeAgents: [] };
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getBtrainStatus()));
  } else if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BTrain Operations</title>
  <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Exo+2:wght@400;500;600&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
  <style>
    :root {
      /* Unified palette — mirrors shared-tokens.css */
      --bg: #0a0c12;
      --surface: #0e1119;
      --surface-hover: #141925;
      --text: #d8e0ec;
      --text-muted: #7a8290;
      --border: #252d3a;
      
      /* Status Colors */
      --idle: #484f58;
      --idle-glow: rgba(72, 79, 88, 0.3);
      --in-progress: #ff8c00;
      --in-progress-glow: rgba(255, 140, 0, 0.2);
      --needs-review: #aa0000;
      --needs-review-glow: rgba(170, 0, 0, 0.2);
      --changes-requested: #ff00ff;
      --changes-requested-glow: rgba(255, 0, 255, 0.2);
      --repair-needed: #ffd000;
      --repair-needed-glow: rgba(255, 208, 0, 0.22);
      --repair-needed-stripe-dark: #111;
      --repair-needed-tape: repeating-linear-gradient(
        -45deg,
        var(--repair-needed-stripe-dark) 0 12px,
        var(--repair-needed) 12px 24px
      );
      --resolved: #00e65c;
      --resolved-glow: rgba(0, 230, 92, 0.2);
      
      --bug: #527a20;
      --bug-glow: rgba(82, 122, 32, 0.4);

      /* Typography tokens */
      --font-heading: 'Chakra Petch', sans-serif;
      --font-body: 'Exo 2', sans-serif;
      --font-mono: 'IBM Plex Mono', monospace;
    }

    * { box-sizing: border-box; }

    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 50% -20%, rgba(30, 40, 60, 0.6) 0%, transparent 60%),
        linear-gradient(rgba(0, 230, 92, 0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 230, 92, 0.02) 1px, transparent 1px);
      background-size: 100% 100%, 40px 40px, 40px 40px;
      color: var(--text);
      font-family: 'Exo 2', sans-serif;
      margin: 0;
      padding: 32px 48px;
      line-height: 1.5;
      min-height: 100vh;
    }

    /* Header */
    .header-container {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
    }

    h1 {
      font-family: 'Chakra Petch', sans-serif;
      text-transform: uppercase;
      font-size: 32px;
      font-weight: 600;
      letter-spacing: 2px;
      margin: 0;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 16px;
      text-shadow: 0 0 10px rgba(255, 255, 255, 0.2);
    }

    .auto-refresh {
      font-family: 'Exo 2', sans-serif;
      font-size: 14px;
      color: var(--text-muted);
      letter-spacing: 1px;
    }

    .agents-container {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    /* Lane Top Indicators (Vertical Mini Cards) */
    .lane-indicators {
      display: flex;
      gap: 12px;
      margin-bottom: 40px;
      flex-wrap: wrap;
    }

    @keyframes hop {
      0%, 93% { transform: translateY(0); }
      95% { transform: translateY(-8px); }
      97% { transform: translateY(0); }
      98% { transform: translateY(-3px); }
      100% { transform: translateY(0); }
    }
    
    @keyframes chug {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(3px); }
    }
    
    @keyframes squish {
      0%, 96% { transform: scaleY(1) translateY(0); }
      98% { transform: scaleY(0.85) translateY(4px); }
      100% { transform: scaleY(1) translateY(0); }
    }
    
    .indicator-pill {
      display: flex;
      flex-direction: column;
      align-items: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      overflow: visible;
      width: 46px; /* Narrow */
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      will-change: transform;
    }

    /* Specific status animations */
    .indicator-pill.status-needs-review {
      animation: hop 1.5s cubic-bezier(0.28, 0.84, 0.42, 1) infinite;
    }
    .indicator-pill.status-changes-requested {
      animation: hop 2.0s cubic-bezier(0.28, 0.84, 0.42, 1) infinite;
    }
    .indicator-pill.status-repair-needed {
      animation: hop 1.8s cubic-bezier(0.28, 0.84, 0.42, 1) infinite;
      border-color: rgba(255, 208, 0, 0.55);
      box-shadow: 0 0 14px var(--repair-needed-glow);
    }
    .indicator-pill.status-in-progress {
      animation: chug 1.5s ease-in-out infinite;
    }
    .indicator-pill.status-resolved {
      animation: squish 30s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      transform-origin: bottom center;
    }

    /* Sequence stagger for the sweeping squish */
    .indicator-pill:nth-child(1) { animation-delay: 0.0s; }
    .indicator-pill:nth-child(2) { animation-delay: 0.1s; }
    .indicator-pill:nth-child(3) { animation-delay: 0.2s; }
    .indicator-pill:nth-child(4) { animation-delay: 0.3s; }
    .indicator-pill:nth-child(5) { animation-delay: 0.4s; }
    .indicator-pill:nth-child(6) { animation-delay: 0.5s; }
    .indicator-pill:nth-child(7) { animation-delay: 0.6s; }
    .indicator-pill:nth-child(8) { animation-delay: 0.7s; }
    .indicator-pill:nth-child(9) { animation-delay: 0.8s; }
    
    .indicator-pill:hover {
      border-color: #555;
    }

    .lane-box {
      width: 100%;
      height: 38px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Chakra Petch', sans-serif;
      font-size: 20px;
      font-weight: 700;
      color: #fff;
      text-transform: uppercase;
      border-bottom: 1px solid var(--border);
    }
    
    .indicator-agent {
      padding: 6px 0;
      font-family: 'Chakra Petch', sans-serif;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      width: 100%;
    }

    .lane-box.idle { background-color: var(--idle); }
    .lane-box.in-progress { background-color: var(--in-progress); box-shadow: 0 0 12px var(--in-progress-glow); }
    .lane-box.needs-review { background-color: var(--needs-review); box-shadow: 0 0 12px var(--needs-review-glow); }
    .lane-box.changes-requested { background-color: var(--changes-requested); box-shadow: 0 0 12px var(--changes-requested-glow); }
    .lane-box.repair-needed {
      background: var(--repair-needed-tape);
      box-shadow: 0 0 12px var(--repair-needed-glow);
      color: #111;
      border-bottom-color: rgba(0, 0, 0, 0.35);
      -webkit-text-stroke: 0.6px #fff;
      paint-order: stroke fill;
      text-shadow: 0 0 3px #fff, 1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff;
    }
    .lane-box.resolved { background-color: var(--resolved); box-shadow: 0 0 12px var(--resolved-glow); }

    /* Lanes Grid */
    .lanes-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 24px;
    }

    /* Lane Card */
    .lane-card {
      background: linear-gradient(145deg, var(--surface) 0%, #0d1017 100%);
      border: 1px solid var(--border);
      border-top: 3px solid var(--border);
      padding: 24px;
      border-radius: 4px;
      cursor: pointer;
      position: relative;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }

    .lane-card:hover {
      background: linear-gradient(145deg, var(--surface-hover) 0%, #151a25 100%);
      border-color: #3b4455;
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }

    .lane-card[data-status="idle"] { border-top-color: var(--idle); }
    .lane-card[data-status="in-progress"] { border-top-color: var(--in-progress); }
    .lane-card[data-status="needs-review"] { border-top-color: var(--needs-review); }
    .lane-card[data-status="changes-requested"] { border-top-color: var(--changes-requested); }
    .lane-card[data-status="repair-needed"] {
      border-top-color: var(--repair-needed);
      overflow: hidden;
    }
    .lane-card[data-status="repair-needed"]::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 12px;
      background: var(--repair-needed-tape);
      box-shadow: 0 0 14px var(--repair-needed-glow);
      pointer-events: none;
    }
    .lane-card[data-status="resolved"] { border-top-color: var(--resolved); }

    /* Hot Seat Badge */
    .lane-hot-seat {
      position: absolute;
      top: -14px;
      right: 24px;
      font-family: 'Chakra Petch', sans-serif;
      font-size: 13px;
      font-weight: 600;
      padding: 4px 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      background: #0d1017;
      border: 1px solid;
    }

    .lane-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .lane-id {
      font-family: 'Chakra Petch', sans-serif;
      font-size: 22px;
      font-weight: 600;
      color: #fff;
    }

    .lane-status {
      font-family: 'Chakra Petch', sans-serif;
      font-size: 13px;
      font-weight: 600;
      padding: 4px 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      background: rgba(0,0,0,0.3);
      border-radius: 2px;
    }

    .status-idle { color: var(--idle); }
    .status-in-progress { color: var(--in-progress); }
    .status-needs-review { color: var(--needs-review); }
    .status-changes-requested { color: var(--changes-requested); }
    .status-repair-needed { color: var(--repair-needed); }
    .status-resolved { color: var(--resolved); }

    .lane-card[data-status="repair-needed"] .lane-status {
      background: var(--repair-needed-tape);
      color: #111;
      border: 1px solid rgba(0, 0, 0, 0.35);
      box-shadow: 0 0 12px rgba(255, 208, 0, 0.12);
      -webkit-text-stroke: 0.6px #fff;
      paint-order: stroke fill;
      text-shadow: 0 0 3px #fff, 1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff;
    }

    .lane-agents-meta {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px dashed var(--border);
    }

    .lane-owner {
      font-family: 'Chakra Petch', sans-serif;
      font-size: 13px;
      color: #a0abb8;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .lane-owner.repair-owner {
      display: inline-flex;
      width: fit-content;
      padding: 4px 10px;
      background: var(--repair-needed-tape);
      color: #111;
      border: 1px solid rgba(0, 0, 0, 0.35);
      box-shadow: 0 0 12px rgba(255, 208, 0, 0.12);
    }

    .lane-owner.repair-owner strong {
      color: #111;
    }

    .lane-desc {
      font-size: 17px;
      color: #fff;
      line-height: 1.4;
      font-weight: 500;
    }

    .lane-packet-summary {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 14px;
    }

    .lane-packet-row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #c6d0dc;
    }

    .lane-packet-label {
      color: var(--text-muted);
      letter-spacing: 1px;
      min-width: 68px;
      flex: 0 0 auto;
    }

    .lane-packet-value {
      white-space: pre-wrap;
    }

    .lane-locks {
      font-family: 'Chakra Petch', sans-serif;
      font-size: 12px;
      color: var(--in-progress);
      margin-top: 16px;
      display: inline-block;
      padding: 4px 8px;
      background: rgba(255, 140, 0, 0.05);
      border: 1px solid rgba(255, 140, 0, 0.2);
    }

    /* Expand / Collapse Details */
    .details-wrapper {
      display: grid;
      grid-template-rows: 0fr;
      transition: grid-template-rows 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .lane-card.expanded .details-wrapper {
      grid-template-rows: 1fr;
    }
    
    .details-overflow-guard {
      overflow: hidden;
    }

    .details-inner {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 13px;
      color: #8b949e;
      white-space: pre-wrap;
      background: rgba(0,0,0,0.3);
      padding: 20px;
      border-left: 3px solid var(--border);
      margin-top: 24px;
      max-height: 400px;
      overflow-y: auto;
      line-height: 1.6;
    }

    .lane-card.expanded {
      border-color: #4b586d;
    }

    .bug-sprout {
      position: absolute;
      top: -24px;
      left: 50%;
      transform: translateX(-50%);
      color: var(--bug);
      animation: hop 2s infinite;
      z-index: 10;
      filter: drop-shadow(0 0 8px var(--bug));
    }
  </style>
</head>
<body>
  <div class="header-container">
    <h1><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg> ${path.basename(process.cwd())} <span style="font-size: 12px; color: var(--text-muted); letter-spacing: 1px; text-transform: lowercase; margin-left: auto;">btrain console</span> <span class="auto-refresh" id="last-updated">INIT...</span></h1>
    <div class="agents-container" id="agents-container"></div>
  </div>

  <div class="lane-indicators" id="lane-indicators-container">
    <!-- Renders top lane pills -->
  </div>
  
  <div class="lanes-grid" id="lanes-container">
    <div style="font-family: 'Chakra Petch', sans-serif; letter-spacing: 2px;">Establishing connection...</div>
  </div>

  <script>
    // State to persist open cards across fetch polls
    const openCardIds = new Set();
    const statusClassNames = ${JSON.stringify(STATUS_CLASS_NAMES)};

    const getAgentIdentity = (name) => {
      if (!name || name === 'Unassigned') return { short: '---', color: '#666' };
      const n = name.toLowerCase();
      if (n.includes('codex') || n.includes('gpt')) return { short: 'codex', color: '#00f0ff' };
      if (n.includes('claude') || n.includes('opus')) return { short: 'claude', color: '#ff00ff' };
      if (n.includes('gemini')) return { short: 'gemini', color: '#ffb300' };
      if (n.includes('antigravity') || n.includes('anti')) return { short: 'antigravity', color: '#b366ff' };
      return { short: n.split(' ')[0] || name.substring(0,6).toLowerCase(), color: '#e6edf3' };
    };

    window.toggleCard = function(id) {
      const card = document.getElementById('card-' + id);
      if (card.classList.contains('expanded')) {
        card.classList.remove('expanded');
        openCardIds.delete(id);
      } else {
        card.classList.add('expanded');
        openCardIds.add(id);
      }
    };

    window.scrollToCard = function(id, event) {
      if (event) event.stopPropagation();
      const card = document.getElementById('card-' + id);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (!card.classList.contains('expanded')) toggleCard(id);
      }
    };

    function renderStatusClass(status) {
      return statusClassNames[status] || '';
    }

    const escapeHtml = (unsafe) => {
      return (unsafe || '').toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    };

    const updateDOMIfChanged = (elId, newHtml) => {
      const el = document.getElementById(elId);
      if (!el) return;
      const temp = document.createElement('div');
      temp.innerHTML = newHtml;
      if (el.innerHTML !== temp.innerHTML) {
        el.innerHTML = newHtml;
      }
    };

    async function fetchStatus() {
      try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        // Active Agents Header
        if (data.activeAgents) {
          const agentsUi = '<span style="color: var(--text-muted); font-family: \\'Chakra Petch\\', sans-serif;">ACTIVE LINKS:</span> ' + data.activeAgents.map(ag => {
            const identity = getAgentIdentity(ag);
            return \`<span style="
              font-family: 'Chakra Petch', sans-serif;
              padding: 4px 12px; border-radius: 2px; font-size: 13px; text-transform: uppercase; font-weight: 700;
              background-color: \${identity.color}15; color: \${identity.color}; border: 1px solid \${identity.color}66;
            ">\${ag}</span>\`;
          }).join('&nbsp;');
          updateDOMIfChanged('agents-container', agentsUi);
        }

        // Top Indicators (Vertical Stack Mini Cards)
        const indicatorsHtml = data.lanes.map(lane => {
          const hasHotSeat = lane.hotSeat && lane.hotSeat !== 'Unassigned' && (lane.status !== 'resolved' || lane.isBug);
          const identity = getAgentIdentity(lane.hotSeat);
          const bugStyle = lane.isBug ? \`background-color: var(--bug-glow); border-color: var(--bug); box-shadow: 0 0 12px var(--bug-glow);\` : '';

          return \`
            <div class="indicator-pill status-\${lane.status} \${hasHotSeat ? 'active' : ''}" style="position:relative; \${bugStyle}" onclick="scrollToCard('\${lane.id}', event)" title="\${lane.status.toUpperCase()}">
              \${lane.isBug ? '<div class="bug-sprout"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3 3.96 0 0 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M17.47 9c1.93-.2 3.53-1.9 3.53-3.9"/><path d="M6 13H2"/><path d="M22 13h-4"/><path d="M6.5 17C4.6 17.2 3 18.9 3 21"/><path d="M17.5 17c1.9.2 3.5 1.9 3.5 3.9"/></svg></div>' : ''}
              <div class="lane-box \${lane.status}">\${lane.id}</div>
              \${hasHotSeat ? \`
                <div class="indicator-agent" style="color: \${identity.color};">\${identity.short}</div>
              \` : \`
                <div class="indicator-agent" style="color: var(--text-muted); text-shadow: none;">---</div>
              \`}
            </div>
          \`;
        }).join('');
        updateDOMIfChanged('lane-indicators-container', indicatorsHtml);

        // Lane Cards
        const lanesHtml = data.lanes.map(lane => {
          const isExpanded = openCardIds.has(lane.id) ? 'expanded' : '';
          const hasHotSeat = lane.hotSeat && lane.hotSeat !== 'Unassigned' && (lane.status !== 'resolved' || lane.isBug);
          const hsIdentity = getAgentIdentity(lane.hotSeat);
          const wIdentity = getAgentIdentity(lane.writer);
          const rIdentity = getAgentIdentity(lane.reviewer);
          const bugCardStyle = lane.isBug ? \`background-color: rgba(60, 90, 20, 0.4); border-color: var(--bug); box-shadow: 0 0 16px var(--bug-glow);\` : '';
          
          return \`
          <div id="card-\${lane.id}" class="lane-card \${isExpanded}" style="position:relative; \${bugCardStyle}" data-status="\${lane.status}" onclick="toggleCard('\${lane.id}')">
            \${lane.isBug ? '<div class="bug-sprout" style="top:-34px;"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3 3.96 0 0 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M17.47 9c1.93-.2 3.53-1.9 3.53-3.9"/><path d="M6 13H2"/><path d="M22 13h-4"/><path d="M6.5 17C4.6 17.2 3 18.9 3 21"/><path d="M17.5 17c1.9.2 3.5 1.9 3.5 3.9"/></svg></div>' : ''}
            \${hasHotSeat ? \`
              <div class="lane-hot-seat" style="color: \${hsIdentity.color}; border-color: \${hsIdentity.color}; box-shadow: 0 0 12px \${hsIdentity.color}40;">
                HOTSEAT // \${hsIdentity.short}
              </div>
            \` : ''}
            
            <div class="lane-header">
              <div class="lane-id">LANE \${lane.id}</div>
              <div class="lane-status \${renderStatusClass(lane.status)}">[\${lane.status}]</div>
            </div>

            \${lane.writer || lane.reviewer || lane.repairOwner ? \`
              <div class="lane-agents-meta">
                \${lane.writer && lane.writer !== '(none)' && lane.writer !== '(unassigned)' ? \`
                  <div class="lane-owner">W // <strong style="color:\${wIdentity.color}">\${lane.writer}</strong></div>
                \` : ''}
                \${lane.reviewer && lane.reviewer !== '(none)' && lane.reviewer !== '(unassigned)' ? \`
                  <div class="lane-owner">R // <strong style="color:\${rIdentity.color}">\${lane.reviewer}</strong></div>
                \` : ''}
                \${lane.status === 'repair-needed' && lane.repairOwner ? \`
                  <div class="lane-owner repair-owner">FIX // <strong>\${lane.repairOwner}</strong></div>
                \` : ''}
              </div>
            \` : ''}

            <div class="lane-desc">\${lane.desc}</div>
            \${lane.objective || lane.doneWhen ? \`
              <div class="lane-packet-summary">
                \${lane.objective ? \`
                  <div class="lane-packet-row">
                    <span class="lane-packet-label">OBJ //</span>
                    <span class="lane-packet-value">\${escapeHtml(lane.objective)}</span>
                  </div>
                \` : ''}
                \${lane.doneWhen ? \`
                  <div class="lane-packet-row">
                    <span class="lane-packet-label">DONE //</span>
                    <span class="lane-packet-value">\${escapeHtml(lane.doneWhen)}</span>
                  </div>
                \` : ''}
              </div>
            \` : ''}
            \${lane.locks ? \`<div class="lane-locks">\${lane.locks}</div>\` : ''}

            <div class="details-wrapper">
              <div class="details-overflow-guard">
                <div class="details-inner">\${escapeHtml(lane.fullText)}</div>
              </div>
            </div>
          </div>
        \`}).join('');

        updateDOMIfChanged('lanes-container', lanesHtml);

        const d = new Date();
        document.getElementById('last-updated').textContent = d.toISOString().split('T')[1].split('.')[0] + ' UTC';
      } catch (err) {
        console.error('Failed to fetch status:', err);
      }
    }

    fetchStatus();
    setInterval(fetchStatus, 3000);
  </script>
</body>
</html>
    `);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[BTrain Dashboard] HUD Status monitor is running on http://localhost:${PORT}`);
});
