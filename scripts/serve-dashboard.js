const http = require('http');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3333;

const HOT_SEAT_RESOLVERS = {
  'in-progress': ({ writer }) => writer,
  'needs-review': ({ reviewer }) => reviewer,
  'changes-requested': ({ writer }) => writer,
  'repair-needed': ({ repairOwner, writer }) => repairOwner || writer,
  'ready-for-pr': ({ writer }) => writer,
  'pr-review': ({ writer }) => writer,
  'ready-to-merge': ({ writer }) => writer
};

const STATUS_CLASS_NAMES = {
  idle: 'status-idle',
  'in-progress': 'status-in-progress',
  'needs-review': 'status-needs-review',
  'changes-requested': 'status-changes-requested',
  'repair-needed': 'status-repair-needed',
  'ready-for-pr': 'status-ready-for-pr',
  'pr-review': 'status-pr-review',
  'ready-to-merge': 'status-ready-to-merge',
  resolved: 'status-resolved'
};

function getActiveAgents(repoRoot) {
  try {
    const tomlPath = path.join(repoRoot, '.btrain', 'project.toml');
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

function buildLaneFullText(lane, repo) {
  const lockPaths = normalizeTextList(lane.lockPaths);
  const reasonTags = normalizeTextList(lane.reasonTags);
  const packet = lane.delegationPacket || {};
  const lines = [
    `Repo: ${repo.name}`,
    `Path: ${repo.path}`,
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

function toDashboardLane(lane, repo) {
  const task = lane.task || '(no task)';
  const writer = lane.owner || '';
  const reviewer = lane.reviewer || '';
  const repairOwner = lane.repairOwner || '';
  const lockPaths = normalizeTextList(lane.lockPaths);
  const packet = lane.delegationPacket || {};
  const objective = summarizeText(packet.objective);
  const doneWhen = summarizeText(packet.doneWhen);
  const fullText = buildLaneFullText(lane, repo);
  let hotSeat = 'Unassigned';
  const resolveHotSeat = HOT_SEAT_RESOLVERS[lane.status];
  if (resolveHotSeat) {
    hotSeat = resolveHotSeat({ writer, reviewer, repairOwner }) || 'Unassigned';
  }

  const laneId = lane._laneId || lane.lane || 'default';
  const repoKey = Buffer.from(repo.path).toString('base64url');
  return {
    id: `${repoKey}-${laneId}`,
    laneId,
    repoName: repo.name,
    repoPath: repo.path,
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
  };
}

function getRepoLanes(repo) {
  if (Array.isArray(repo.lanes) && repo.lanes.length > 0) {
    return repo.lanes;
  }
  if (repo.current) {
    return [{ ...repo.current, _laneId: 'default' }];
  }
  return [];
}

function getRegisteredRepos() {
  try {
    return JSON.parse(execFileSync('btrain', ['repos', '--json'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }));
  } catch (error) {
    console.error('Error fetching registered repos:', error);
    return [];
  }
}

function updateRegisteredRepo(action, repoPath) {
  if (!['enable', 'disable', 'remove'].includes(action)) {
    throw new Error(`Unsupported repo action: ${action}`);
  }
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('A repo path is required.');
  }
  execFileSync('btrain', ['repos', action, repoPath], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function getBtrainStatus() {
  try {
    const registeredRepos = getRegisteredRepos();
    const raw = execFileSync('btrain', ['status', '--json'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const statuses = JSON.parse(raw);
    const repositories = [];
    const unavailableRepos = [];
    const activeAgents = new Set();

    for (const repo of Array.isArray(statuses) ? statuses : []) {
      if (!repo?.path || repo.current?.status === 'missing') {
        unavailableRepos.push({ name: repo?.name || '(unknown)', path: repo?.path || '', status: 'missing' });
        continue;
      }

      const sourceLanes = getRepoLanes(repo);
      const agents = getActiveAgents(repo.path);
      agents.forEach((agent) => activeAgents.add(agent));
      repositories.push({
        name: repo.name,
        path: repo.path,
        lanes: sourceLanes.map((lane) => toDashboardLane(lane, repo)),
      });
    }

    return {
      scope: 'global',
      repositories,
      lanes: repositories.flatMap((repo) => repo.lanes),
      activeAgents: [...activeAgents].sort(),
      unavailableRepos,
      repoControls: registeredRepos.map((repo) => ({
        name: repo.name,
        path: repo.path,
        enabled: repo.enabled !== false,
        available: fs.existsSync(repo.path),
      })),
    };
  } catch (error) {
    console.error('Error fetching btrain status:', error);
    return { scope: 'global', repositories: [], lanes: [], activeAgents: [], unavailableRepos: [], repoControls: [] };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getBtrainStatus()));
  } else if (req.url === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, scope: 'global', port: PORT }));
  } else if (req.url === '/api/repositories' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      updateRegisteredRepo(body.action, body.path);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
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
      --ready-for-pr: #00c8ff;
      --ready-for-pr-glow: rgba(0, 200, 255, 0.22);
      --pr-review: #8b7cff;
      --pr-review-glow: rgba(139, 124, 255, 0.22);
      --ready-to-merge: #35f2b0;
      --ready-to-merge-glow: rgba(53, 242, 176, 0.22);
      --resolved: #00e65c;
      --resolved-glow: rgba(0, 230, 92, 0.2);

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
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .network-summary,
    .unavailable-repos {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 18px;
    }

    .unavailable-repos {
      color: var(--repair-needed);
    }

    .repo-controls-panel {
      margin: 0 0 22px;
      border: 1px solid var(--border);
      background: rgba(13, 16, 23, 0.72);
      padding: 12px 14px;
    }

    .repo-controls-panel summary {
      cursor: pointer;
      color: var(--text-muted);
      font-family: 'Chakra Petch', sans-serif;
      font-size: 12px;
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    .repo-controls {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 8px;
      margin-top: 12px;
    }

    .repo-control {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
    }

    .repo-control.disabled { opacity: 0.58; }
    .repo-control.missing { border-color: rgba(255, 208, 0, 0.45); }

    .repo-control-name {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .repo-control button {
      cursor: pointer;
      border: 1px solid var(--border);
      background: #111722;
      color: #d9e1ea;
      padding: 4px 7px;
      font-family: 'Chakra Petch', sans-serif;
      font-size: 10px;
      text-transform: uppercase;
    }

    .repo-control button:hover { border-color: var(--in-progress); }
    .repo-control button.remove:hover { border-color: var(--changes-requested); color: var(--changes-requested); }

    .indicator-repo {
      width: 100%;
      padding: 2px;
      overflow: hidden;
      color: var(--text-muted);
      font-family: 'IBM Plex Mono', monospace;
      font-size: 7px;
      line-height: 1.2;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Lane Top Indicators (Vertical Mini Cards) */
    .lane-indicators {
      display: flex;
      gap: 6px;
      margin-bottom: 28px;
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
      width: 48px;
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
    .indicator-pill.status-ready-for-pr,
    .indicator-pill.status-pr-review {
      animation: chug 1.8s ease-in-out infinite;
    }
    .indicator-pill.status-ready-to-merge {
      animation: hop 2.2s cubic-bezier(0.28, 0.84, 0.42, 1) infinite;
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
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Chakra Petch', sans-serif;
      font-size: 15px;
      font-weight: 700;
      color: #fff;
      text-transform: uppercase;
      border-bottom: 1px solid var(--border);
    }
    
    .indicator-agent {
      padding: 3px 0;
      font-family: 'Chakra Petch', sans-serif;
      font-size: 8px;
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
    .lane-box.ready-for-pr { background-color: var(--ready-for-pr); box-shadow: 0 0 12px var(--ready-for-pr-glow); color: #061019; }
    .lane-box.pr-review { background-color: var(--pr-review); box-shadow: 0 0 12px var(--pr-review-glow); }
    .lane-box.ready-to-merge { background-color: var(--ready-to-merge); box-shadow: 0 0 12px var(--ready-to-merge-glow); color: #06130e; }
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

    .repo-tag {
      max-width: calc(100% - 120px);
      margin-bottom: 12px;
      overflow: hidden;
      color: var(--ready-for-pr);
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.5px;
      text-overflow: ellipsis;
      white-space: nowrap;
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
    .lane-card[data-status="ready-for-pr"] { border-top-color: var(--ready-for-pr); }
    .lane-card[data-status="pr-review"] { border-top-color: var(--pr-review); }
    .lane-card[data-status="ready-to-merge"] { border-top-color: var(--ready-to-merge); }
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
    .status-ready-for-pr { color: var(--ready-for-pr); }
    .status-pr-review { color: var(--pr-review); }
    .status-ready-to-merge { color: var(--ready-to-merge); }
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

  </style>
</head>
<body>
  <div class="header-container">
    <h1><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg> BTrain Network <span style="font-size: 12px; color: var(--text-muted); letter-spacing: 1px; text-transform: lowercase; margin-left: auto;">global console</span> <span class="auto-refresh" id="last-updated">INIT...</span></h1>
    <div class="agents-container" id="agents-container"></div>
  </div>

  <div class="network-summary" id="network-summary">Discovering registered repos...</div>
  <div class="unavailable-repos" id="unavailable-repos"></div>
  <details class="repo-controls-panel">
    <summary id="repo-controls-summary">Manage repositories</summary>
    <div class="repo-controls" id="repo-controls"></div>
  </details>

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

    async function updateRepo(action, repoPath) {
      if (action === 'remove' && !window.confirm('Remove this repo from the BTrain registry? This does not delete project files.')) {
        return;
      }
      const response = await fetch('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, path: repoPath }),
      });
      const result = await response.json();
      if (!response.ok) {
        window.alert(result.error || 'Repository update failed.');
        return;
      }
      await fetchStatus();
    }

    const escapeHtml = (unsafe) => {
      return (unsafe || '').toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    };

    const escapeAttribute = (unsafe) => escapeHtml(unsafe)
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

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

        const repoCount = data.repositories?.length || 0;
        const laneCount = data.lanes?.length || 0;
        updateDOMIfChanged('network-summary', \`REGISTERED NETWORK // \${repoCount} healthy repos // \${laneCount} lanes\`);
        const unavailableUi = (data.unavailableRepos || []).length > 0
          ? \`UNAVAILABLE REGISTRY ENTRIES // \${data.unavailableRepos.map(repo => escapeHtml(repo.name)).join(' // ')}\`
          : '';
        updateDOMIfChanged('unavailable-repos', unavailableUi);

        const repoControls = data.repoControls || [];
        document.getElementById('repo-controls-summary').textContent = \`MANAGE REPOSITORIES // \${repoControls.filter(repo => repo.enabled).length} ON // \${repoControls.filter(repo => !repo.enabled).length} OFF\`;
        const repoControlsHtml = repoControls.map(repo => \`
          <div class="repo-control \${repo.enabled ? '' : 'disabled'} \${repo.available ? '' : 'missing'}" title="\${escapeAttribute(repo.path)}">
            <span class="repo-control-name">\${escapeHtml(repo.name)}\${repo.available ? '' : ' // missing'}</span>
            <button data-repo-action="\${repo.enabled ? 'disable' : 'enable'}" data-repo-path="\${escapeAttribute(repo.path)}">\${repo.enabled ? 'off' : 'on'}</button>
            <button class="remove" data-repo-action="remove" data-repo-path="\${escapeAttribute(repo.path)}">remove</button>
          </div>
        \`).join('');
        updateDOMIfChanged('repo-controls', repoControlsHtml);
        
        // Active Agents Header
        if (data.activeAgents) {
          const agentsUi = '<span style="color: var(--text-muted); font-family: \\'Chakra Petch\\', sans-serif;">ACTIVE LINKS:</span> ' + data.activeAgents.map(ag => {
            const identity = getAgentIdentity(ag);
            return \`<span style="
              font-family: 'Chakra Petch', sans-serif;
              padding: 4px 12px; border-radius: 2px; font-size: 13px; text-transform: uppercase; font-weight: 700;
              background-color: \${identity.color}15; color: \${identity.color}; border: 1px solid \${identity.color}66;
            ">\${escapeHtml(ag)}</span>\`;
          }).join('&nbsp;');
          updateDOMIfChanged('agents-container', agentsUi);
        }

        // Top Indicators (Vertical Stack Mini Cards)
        const indicatorsHtml = data.lanes.map(lane => {
          const hasHotSeat = lane.hotSeat && lane.hotSeat !== 'Unassigned' && lane.status !== 'resolved';
          const identity = getAgentIdentity(lane.hotSeat);

          return \`
            <div class="indicator-pill status-\${lane.status} \${hasHotSeat ? 'active' : ''}" onclick="scrollToCard('\${lane.id}', event)" title="\${escapeHtml(lane.repoName)} // \${lane.status.toUpperCase()}">
              <div class="indicator-repo">\${escapeHtml(lane.repoName)}</div>
              <div class="lane-box \${lane.status}">\${escapeHtml(lane.laneId)}</div>
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
          const hasHotSeat = lane.hotSeat && lane.hotSeat !== 'Unassigned' && lane.status !== 'resolved';
          const hsIdentity = getAgentIdentity(lane.hotSeat);
          const wIdentity = getAgentIdentity(lane.writer);
          const rIdentity = getAgentIdentity(lane.reviewer);
          
          return \`
          <div id="card-\${lane.id}" class="lane-card \${isExpanded}" data-status="\${lane.status}" onclick="toggleCard('\${lane.id}')">
            <div class="repo-tag" title="\${escapeAttribute(lane.repoPath)}">REPO // \${escapeHtml(lane.repoName)}</div>
            \${hasHotSeat ? \`
              <div class="lane-hot-seat" style="color: \${hsIdentity.color}; border-color: \${hsIdentity.color}; box-shadow: 0 0 12px \${hsIdentity.color}40;">
                HOTSEAT // \${hsIdentity.short}
              </div>
            \` : ''}
            
            <div class="lane-header">
              <div class="lane-id">LANE \${escapeHtml(lane.laneId)}</div>
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

            <div class="lane-desc">\${escapeHtml(lane.desc)}</div>
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
    document.getElementById('repo-controls').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-repo-action]');
      if (button) updateRepo(button.dataset.repoAction, button.dataset.repoPath);
    });
  </script>
</body>
</html>
    `);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[BTrain Dashboard] HUD Status monitor is running on http://127.0.0.1:${PORT}`);
});
