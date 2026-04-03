const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3333;

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

function getBtrainStatus() {
  try {
    const raw = execSync('btrain status --repo .').toString();
    const lanes = [];
    const lines = raw.split('\n');

    let currentLanes = [];

    for (const line of lines) {
      if (line.includes('lane ')) {
        const match = line.match(/lane (\w): ([-a-zA-Z]+) — (.*?)\((.*?)\)(?: \[(.*?)\])?/);
        if (match) {
          const laneId = match[1];
          const status = match[2];
          let desc = match[3].trim();
          let writer = match[4];
          let reviewer = 'any-other';
          let bodyText = '';
          
          try {
            const hwPath = path.join(process.cwd(), '.claude', 'collab', `HANDOFF_${laneId.toUpperCase()}.md`);
            if (fs.existsSync(hwPath)) {
              const fileContent = fs.readFileSync(hwPath, 'utf8');
              bodyText = fileContent;
              const aaMatch = fileContent.match(/Active Agent:\s*(.+)/);
              const prMatch = fileContent.match(/Peer Reviewer:\s*(.+)/);
              if (aaMatch) writer = aaMatch[1].trim();
              if (prMatch) reviewer = prMatch[1].trim();
            }
          } catch(e) { }

          let hotSeat = 'Unassigned';
          const isBugCandidate = desc.toLowerCase().includes('bug') || desc.toLowerCase().includes('issue') || bodyText.toLowerCase().includes('bug') || bodyText.toLowerCase().includes('issue');
          const isBug = isBugCandidate && status !== 'resolved';

          if (status === 'in-progress') hotSeat = writer;
          else if (status === 'needs-review') hotSeat = reviewer;

          currentLanes.push({
            id: laneId,
            status: status,
            desc: desc,
            writer: writer,
            reviewer: reviewer,
            hotSeat: hotSeat,
            locks: match[5] || '',
            fullText: bodyText,
            isBug: isBug
          });
        } else {
          const idleMatch = line.match(/lane (\w): (idle) — \(no task\)/);
          if (idleMatch) {
            currentLanes.push({
              id: idleMatch[1],
              status: idleMatch[2],
              desc: '(no task)',
              writer: '',
              reviewer: '',
              hotSeat: 'Unassigned',
              locks: '',
              fullText: 'Lane is currently idle.'
            });
          }
        }
      }
    }
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
      --bg: #050608;
      --surface: #0a0d14;
      --surface-hover: #10141e;
      --text: #e6edf3;
      --text-muted: #7d8590;
      --border: #232b38;
      
      /* Status Colors */
      --idle: #484f58;
      --idle-glow: rgba(72, 79, 88, 0.3);
      --in-progress: #ff8c00;
      --in-progress-glow: rgba(255, 140, 0, 0.2);
      --needs-review: #ff2a2a;
      --needs-review-glow: rgba(255, 42, 42, 0.2);
      --resolved: #00e65c;
      --resolved-glow: rgba(0, 230, 92, 0.2);
      
      --bug: #527a20;
      --bug-glow: rgba(82, 122, 32, 0.4);
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
    .status-resolved { color: var(--resolved); }

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

    .lane-desc {
      font-size: 17px;
      color: #fff;
      line-height: 1.4;
      font-weight: 500;
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
      font-size: 20px;
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

    // Agent Color Identity definitions
    const getAgentIdentity = (name) => {
      if (!name || name === 'Unassigned') return { short: '---', color: '#666' };
      if (name.includes('Codex')) return { short: 'GPT', color: '#00f0ff' }; // Neon Cyan
      if (name.includes('Opus')) return { short: 'OPUS', color: '#ff00ff' }; // Neon Magenta
      if (name.includes('Antigravity') || name.includes('Anti')) return { short: 'ANTI', color: '#b366ff' }; // Neon Violet
      return { short: name.substring(0,4).toUpperCase(), color: '#e6edf3' }; // Fallback White
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
      if (status === 'idle') return 'status-idle';
      if (status === 'in-progress') return 'status-in-progress';
      if (status === 'needs-review') return 'status-needs-review';
      if (status === 'resolved') return 'status-resolved';
      return '';
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
              \${lane.isBug ? '<div class="bug-sprout">🐞</div>' : ''}
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
        const container = document.getElementById('lanes-container');
        
        const lanesHtml = data.lanes.map(lane => {
          const isExpanded = openCardIds.has(lane.id) ? 'expanded' : '';
          const hasHotSeat = lane.hotSeat && lane.hotSeat !== 'Unassigned' && (lane.status !== 'resolved' || lane.isBug);
          const hsIdentity = getAgentIdentity(lane.hotSeat);
          const wIdentity = getAgentIdentity(lane.writer);
          const rIdentity = getAgentIdentity(lane.reviewer);
          const bugCardStyle = lane.isBug ? \`background-color: rgba(60, 90, 20, 0.4); border-color: var(--bug); box-shadow: 0 0 16px var(--bug-glow);\` : '';
          
          return \`
          <div id="card-\${lane.id}" class="lane-card \${isExpanded}" style="position:relative; \${bugCardStyle}" data-status="\${lane.status}" onclick="toggleCard('\${lane.id}')">
            \${lane.isBug ? '<div class="bug-sprout" style="font-size:32px; top:-28px;">🐞</div>' : ''}
            \${hasHotSeat ? \`
              <div class="lane-hot-seat" style="color: \${hsIdentity.color}; border-color: \${hsIdentity.color}; box-shadow: 0 0 12px \${hsIdentity.color}40;">
                HOTSEAT // \${hsIdentity.short}
              </div>
            \` : ''}
            
            <div class="lane-header">
              <div class="lane-id">LANE \${lane.id}</div>
              <div class="lane-status \${renderStatusClass(lane.status)}">[\${lane.status}]</div>
            </div>

            \${lane.writer || lane.reviewer ? \`
              <div class="lane-agents-meta">
                \${lane.writer && lane.writer !== '(none)' && lane.writer !== '(unassigned)' ? \`
                  <div class="lane-owner">W // <strong style="color:\${wIdentity.color}">\${lane.writer}</strong></div>
                \` : ''}
                \${lane.reviewer && lane.reviewer !== '(none)' && lane.reviewer !== '(unassigned)' ? \`
                  <div class="lane-owner">R // <strong style="color:\${rIdentity.color}">\${lane.reviewer}</strong></div>
                \` : ''}
              </div>
            \` : ''}

            <div class="lane-desc">\${lane.desc}</div>
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
