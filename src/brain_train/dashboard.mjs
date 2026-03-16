import http from "node:http"
import { getStatus, listLocks, getBrainTrainHome } from "./core.mjs"

function buildDashboardHTML() {
  // Using a function to construct the HTML avoids nested template literal issues
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <title>btrain — Lane Dashboard</title>',
    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">',
    '<style>',
    `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #080810;
  --bg-card: #10101c;
  --bg-card-hover: #161628;
  --border: #1e1e38;
  --text: #e4e4ef;
  --text-dim: #7878a0;
  --accent: #6c5ce7;
  --accent-glow: rgba(108, 92, 231, 0.2);
  --green: #00d68f;
  --green-glow: rgba(0, 214, 143, 0.35);
  --yellow: #ffc107;
  --yellow-glow: rgba(255, 193, 7, 0.3);
  --red: #ff6b6b;
  --blue: #54a0ff;
  --blue-glow: rgba(84, 160, 255, 0.3);
  --orange: #ff9f43;
  --orange-glow: rgba(255, 159, 67, 0.2);
  --mountain-base: #12122a;
  --mountain-glow-idle: rgba(108, 92, 231, 0.05);
  --mountain-glow-active: rgba(0, 214, 143, 0.25);
  --track-color: #2a2a44;
  --font: 'Inter', -apple-system, system-ui, sans-serif;
  --mono: 'JetBrains Mono', monospace;
}

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  overflow-x: hidden;
}

/* ── Animated mountain skyline background ── */
.scene {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 350px;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}

.mountains {
  position: absolute;
  bottom: 0;
  width: 200%;
  height: 280px;
}

.mountain {
  position: absolute;
  bottom: 0;
  border-left: 0 solid transparent;
  border-right: 0 solid transparent;
}

.mountain-1 {
  left: 5%; width: 0; height: 0;
  border-left: 180px solid transparent;
  border-right: 180px solid transparent;
  border-bottom: 260px solid var(--mountain-base);
  filter: brightness(0.8);
}
.mountain-2 {
  left: 20%; width: 0; height: 0;
  border-left: 220px solid transparent;
  border-right: 200px solid transparent;
  border-bottom: 220px solid var(--mountain-base);
  filter: brightness(0.65);
}
.mountain-3 {
  left: 40%; width: 0; height: 0;
  border-left: 160px solid transparent;
  border-right: 250px solid transparent;
  border-bottom: 280px solid var(--mountain-base);
  filter: brightness(0.75);
}
.mountain-4 {
  left: 60%; width: 0; height: 0;
  border-left: 200px solid transparent;
  border-right: 180px solid transparent;
  border-bottom: 200px solid var(--mountain-base);
  filter: brightness(0.6);
}
.mountain-5 {
  left: 78%; width: 0; height: 0;
  border-left: 240px solid transparent;
  border-right: 160px solid transparent;
  border-bottom: 245px solid var(--mountain-base);
  filter: brightness(0.7);
}

.mountain-glow {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 280px;
  background: var(--mountain-glow-idle);
  transition: background 1.5s ease;
}
.mountain-glow.active {
  background: var(--mountain-glow-active);
}

.stars {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
}
.star {
  position: absolute;
  border-radius: 50%;
  background: #fff;
  animation: twinkle 3s ease-in-out infinite;
}
@keyframes twinkle {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

/* ── Track / rail at bottom of scene ── */
.track {
  position: absolute;
  bottom: 0;
  left: 0; right: 0;
  height: 6px;
  background: var(--track-color);
  box-shadow: 0 0 12px rgba(108, 92, 231, 0.3);
}
.track::before {
  content: '';
  position: absolute;
  top: -2px; left: 0; right: 0;
  height: 2px;
  background: repeating-linear-gradient(
    90deg,
    var(--track-color) 0px,
    var(--track-color) 30px,
    transparent 30px,
    transparent 50px
  );
}

/* ── Header ── */
.header {
  position: sticky;
  top: 0;
  padding: 1rem 2rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(8, 8, 16, 0.88);
  backdrop-filter: blur(24px);
  z-index: 100;
}
.header-left { display: flex; align-items: center; gap: 0.75rem; }
.logo { font-size: 1.3rem; font-weight: 800; letter-spacing: -0.02em; }
.logo-icon { margin-right: 0.25rem; }
.header-badge {
  font-size: 0.65rem; font-weight: 600;
  background: var(--accent-glow); color: var(--accent);
  padding: 0.2rem 0.6rem; border-radius: 20px;
  letter-spacing: 0.05em; text-transform: uppercase;
}
.header-right { display: flex; align-items: center; gap: 1rem; }
.pulse-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--green);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(0,214,143,0.4); }
  50% { opacity: 0.7; box-shadow: 0 0 0 8px rgba(0,214,143,0); }
}
.poll-label { font-size: 0.78rem; color: var(--text-dim); }

/* ── Main content ── */
.main {
  position: relative;
  z-index: 1;
  padding: 2rem;
  padding-top: 380px;
  max-width: 1100px;
  margin: 0 auto;
}

/* ── Repo section ── */
.repo-section { margin-bottom: 3rem; }
.repo-header { margin-bottom: 1.25rem; }
.repo-name { font-size: 1.4rem; font-weight: 800; letter-spacing: -0.02em; }
.repo-path { font-family: var(--mono); font-size: 0.72rem; color: var(--text-dim); margin-top: 0.15rem; }

/* ── Train track for lanes ── */
.train-track {
  position: relative;
  padding: 1.5rem 0;
}
.train-track::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0; right: 0;
  height: 4px;
  background: var(--track-color);
  transform: translateY(-50%);
  border-radius: 2px;
}
.train-track::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0; right: 0;
  height: 2px;
  transform: translateY(-50%);
  background: repeating-linear-gradient(
    90deg,
    transparent 0px,
    transparent 10px,
    var(--border) 10px,
    var(--border) 30px,
    transparent 30px,
    transparent 40px
  );
}

.lanes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 1.25rem;
  position: relative;
  z-index: 1;
}

/* ── Train car (lane card) ── */
.lane-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 1.5rem;
  position: relative;
  overflow: hidden;
  transition: all 0.4s ease;
}
.lane-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: var(--border);
  transition: background 0.5s ease, box-shadow 0.5s ease;
}
.lane-card:hover {
  background: var(--bg-card-hover);
  transform: translateY(-3px);
}

/* Wheels */
.lane-card::after {
  content: '';
  position: absolute;
  bottom: -8px;
  left: 20%;
  width: 16px; height: 16px;
  border-radius: 50%;
  background: var(--track-color);
  border: 2px solid var(--border);
  box-shadow: calc(60% + 40px) 0 0 0 var(--track-color),
              calc(60% + 40px) 0 0 2px var(--border);
}

/* Status-based glow for the top bar */
.lane-card.status-in-progress::before {
  background: var(--blue);
  box-shadow: 0 0 20px var(--blue-glow), 0 0 60px var(--blue-glow);
}
.lane-card.status-needs-review::before {
  background: var(--yellow);
  box-shadow: 0 0 20px var(--yellow-glow), 0 0 60px var(--yellow-glow);
}
.lane-card.status-resolved::before {
  background: var(--green);
  box-shadow: 0 0 15px var(--green-glow);
}
.lane-card.status-in-progress {
  border-color: rgba(84, 160, 255, 0.25);
  box-shadow: 0 8px 40px rgba(84, 160, 255, 0.08);
}
.lane-card.status-needs-review {
  border-color: rgba(255, 193, 7, 0.2);
  box-shadow: 0 8px 40px rgba(255, 193, 7, 0.06);
}

/* Chugging animation for in-progress cards */
.lane-card.status-in-progress {
  animation: chug 0.6s ease-in-out infinite;
}
@keyframes chug {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(2px) translateY(-1px); }
  75% { transform: translateX(-1px) translateY(0.5px); }
}

.lane-header {
  display: flex; align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}
.lane-id {
  font-family: var(--mono);
  font-size: 0.75rem; font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--accent);
  display: flex; align-items: center; gap: 0.4rem;
}
.lane-id::before { content: '🚃'; font-size: 0.9rem; }

.status-badge {
  font-size: 0.65rem; font-weight: 600;
  padding: 0.25rem 0.7rem;
  border-radius: 20px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.badge-idle { background: rgba(120,120,160,0.1); color: var(--text-dim); border: 1px solid var(--border); }
.badge-in-progress { background: rgba(84,160,255,0.12); color: var(--blue); }
.badge-needs-review { background: rgba(255,193,7,0.12); color: var(--yellow); }
.badge-resolved { background: rgba(0,214,143,0.12); color: var(--green); }

.lane-task {
  font-size: 0.95rem; font-weight: 600;
  margin-bottom: 0.85rem;
  min-height: 1.4em;
  line-height: 1.4;
}
.lane-task.empty { color: var(--text-dim); font-weight: 400; font-style: italic; }

.lane-meta { display: flex; flex-direction: column; gap: 0.3rem; }
.meta-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.78rem; }
.meta-label { color: var(--text-dim); min-width: 62px; font-weight: 500; }
.meta-value { color: var(--text); }
.meta-value.dim { color: var(--text-dim); font-style: italic; }

/* ── Single-lane fallback ── */
.single-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 1.5rem;
}

/* ── Locks ── */
.locks-section { margin-top: 1.25rem; }
.locks-title {
  font-size: 0.82rem; font-weight: 600;
  margin-bottom: 0.6rem;
  display: flex; align-items: center; gap: 0.5rem;
}
.lock-count {
  font-size: 0.65rem;
  background: var(--orange-glow); color: var(--orange);
  padding: 0.12rem 0.5rem; border-radius: 20px; font-weight: 600;
}
.lock-list { display: flex; flex-direction: column; gap: 0.35rem; }
.lock-item {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.78rem; font-family: var(--mono);
  background: rgba(255,159,67,0.05);
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  border: 1px solid rgba(255,159,67,0.1);
}
.lock-lane-tag {
  font-size: 0.6rem; font-weight: 600;
  background: var(--accent-glow); color: var(--accent);
  padding: 0.08rem 0.4rem; border-radius: 4px;
  text-transform: uppercase;
}
.lock-path { color: var(--orange); }
.lock-owner { color: var(--text-dim); font-family: var(--font); }

/* ── Error / empty ── */
.error-banner {
  background: rgba(255,107,107,0.08);
  border: 1px solid rgba(255,107,107,0.2);
  border-radius: 8px; padding: 0.75rem 1rem;
  color: var(--red); font-size: 0.82rem;
  margin-bottom: 1.5rem; display: none;
}
.empty-state {
  text-align: center; padding: 3rem 2rem;
  color: var(--text-dim);
}
.empty-state h2 { font-size: 1.15rem; margin-bottom: 0.4rem; color: var(--text); }

@media (max-width: 600px) {
  .header { padding: 0.75rem 1rem; }
  .main { padding: 1rem; padding-top: 360px; }
  .lanes-grid { grid-template-columns: 1fr; }
}
`,
    '</style>',
    '</head>',
    '<body>',
    '',
    '<!-- Animated nighttime mountain scene -->',
    '<div class="scene" id="scene">',
    '  <div class="stars" id="stars"></div>',
    '  <div class="mountain-glow" id="mountainGlow"></div>',
    '  <div class="mountains">',
    '    <div class="mountain mountain-1"></div>',
    '    <div class="mountain mountain-2"></div>',
    '    <div class="mountain mountain-3"></div>',
    '    <div class="mountain mountain-4"></div>',
    '    <div class="mountain mountain-5"></div>',
    '  </div>',
    '  <div class="track"></div>',
    '</div>',
    '',
    '<header class="header">',
    '  <div class="header-left">',
    '    <div class="logo"><span class="logo-icon">⚡</span> btrain</div>',
    '    <span class="header-badge">Lane Dashboard</span>',
    '  </div>',
    '  <div class="header-right">',
    '    <div class="pulse-dot"></div>',
    '    <span class="poll-label">Live · 3s</span>',
    '  </div>',
    '</header>',
    '',
    '<main class="main">',
    '  <div id="error" class="error-banner"></div>',
    '  <div id="content">',
    '    <div class="empty-state"><h2>Loading...</h2><p>Connecting to btrain</p></div>',
    '  </div>',
    '</main>',
    '',
    '<script>',
    `
// Generate twinkling stars
(function() {
  var container = document.getElementById("stars");
  for (var i = 0; i < 60; i++) {
    var s = document.createElement("div");
    s.className = "star";
    var size = Math.random() * 2 + 1;
    s.style.width = size + "px";
    s.style.height = size + "px";
    s.style.left = Math.random() * 100 + "%";
    s.style.top = Math.random() * 70 + "%";
    s.style.animationDelay = (Math.random() * 5) + "s";
    s.style.animationDuration = (2 + Math.random() * 4) + "s";
    container.appendChild(s);
  }
})();

var POLL_MS = 3000;
var lastJson = "";

function esc(s) {
  var d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function badgeClass(status) {
  var s = (status || "idle").replace(/\\s+/g, "-");
  return "badge-" + s;
}

function cardStatusClass(status) {
  var s = (status || "idle").replace(/\\s+/g, "-");
  return "status-" + s;
}

function renderLaneCard(lane) {
  var task = lane.task;
  var status = lane.status || "idle";
  var owner = lane.owner;
  var reviewer = lane.reviewer;
  var hasTask = task && task !== "(none)";

  return '<div class="lane-card ' + cardStatusClass(status) + '">'
    + '<div class="lane-header">'
    + '<span class="lane-id">Lane ' + esc(lane._laneId || "?") + '</span>'
    + '<span class="status-badge ' + badgeClass(status) + '">' + esc(status) + '</span>'
    + '</div>'
    + '<div class="lane-task' + (hasTask ? '' : ' empty') + '">' + (hasTask ? esc(task) : 'No active task') + '</div>'
    + '<div class="lane-meta">'
    + '<div class="meta-row"><span class="meta-label">Owner</span><span class="meta-value' + (owner ? '' : ' dim') + '">' + esc(owner || 'unassigned') + '</span></div>'
    + '<div class="meta-row"><span class="meta-label">Reviewer</span><span class="meta-value' + (reviewer ? '' : ' dim') + '">' + esc(reviewer || 'unassigned') + '</span></div>'
    + '<div class="meta-row"><span class="meta-label">Mode</span><span class="meta-value">' + esc(lane.reviewMode || 'manual') + '</span></div>'
    + '</div></div>';
}

function renderSingleLane(repo) {
  var c = repo.current || {};
  return '<div class="single-card">'
    + '<div class="lane-header">'
    + '<span class="lane-id">Single Lane</span>'
    + '<span class="status-badge ' + badgeClass(c.status) + '">' + esc(c.status || 'idle') + '</span>'
    + '</div>'
    + '<div class="lane-task' + (c.task ? '' : ' empty') + '">' + (c.task ? esc(c.task) : 'No active task') + '</div>'
    + '<div class="lane-meta">'
    + '<div class="meta-row"><span class="meta-label">Owner</span><span class="meta-value' + (c.owner ? '' : ' dim') + '">' + esc(c.owner || 'unassigned') + '</span></div>'
    + '<div class="meta-row"><span class="meta-label">Reviewer</span><span class="meta-value' + (c.reviewer ? '' : ' dim') + '">' + esc(c.reviewer || 'unassigned') + '</span></div>'
    + '</div></div>';
}

function renderLocks(locks) {
  if (!locks || locks.length === 0) return "";
  var items = locks.map(function(l) {
    return '<div class="lock-item">'
      + '<span class="lock-lane-tag">' + esc(l.lane) + '</span>'
      + '<span class="lock-path">' + esc(l.path) + '</span>'
      + '<span class="lock-owner">' + esc(l.owner) + '</span>'
      + '</div>';
  }).join("");
  return '<div class="locks-section">'
    + '<div class="locks-title">🔒 File Locks <span class="lock-count">' + locks.length + '</span></div>'
    + '<div class="lock-list">' + items + '</div></div>';
}

function updateMountainGlow(repos) {
  var anyActive = repos.some(function(r) {
    if (r.lanes) {
      return r.lanes.some(function(l) {
        return l.status === "in-progress" || l.status === "needs-review";
      });
    }
    return r.current && (r.current.status === "in-progress" || r.current.status === "needs-review");
  });
  var el = document.getElementById("mountainGlow");
  if (anyActive) {
    el.classList.add("active");
  } else {
    el.classList.remove("active");
  }
}

function render(data) {
  if (!data.repos || data.repos.length === 0) {
    document.getElementById("content").innerHTML =
      '<div class="empty-state"><h2>No repos registered</h2>'
      + '<p>Run <code>btrain init /path/to/repo</code> to get started</p></div>';
    return;
  }

  updateMountainGlow(data.repos);

  var html = data.repos.map(function(repo) {
    var lanesHtml = "";
    if (repo.lanes) {
      lanesHtml = '<div class="train-track"><div class="lanes-grid">'
        + repo.lanes.map(renderLaneCard).join("")
        + '</div></div>';
    } else {
      lanesHtml = renderSingleLane(repo);
    }

    return '<div class="repo-section">'
      + '<div class="repo-header">'
      + '<div class="repo-name">' + esc(repo.name) + '</div>'
      + '<div class="repo-path">' + esc(repo.path) + '</div>'
      + '</div>'
      + lanesHtml
      + renderLocks(repo.locks)
      + '</div>';
  }).join("");

  document.getElementById("content").innerHTML = html;
}

function fetchState() {
  fetch("/api/state").then(function(res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function(data) {
    document.getElementById("error").style.display = "none";
    var json = JSON.stringify(data);
    if (json !== lastJson) {
      lastJson = json;
      render(data);
    }
  }).catch(function(e) {
    var el = document.getElementById("error");
    el.textContent = "Connection lost: " + e.message;
    el.style.display = "block";
  });
}

fetchState();
setInterval(fetchState, POLL_MS);
`,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n')

  return html
}

export async function startDashboard({ port = 3456 } = {}) {
  const dashboardHTML = buildDashboardHTML()

  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/state") {
      try {
        const statuses = await getStatus()
        const repos = []
        for (const status of statuses) {
          const repo = { ...status }
          if (status.locks === undefined && status.lanes) {
            try {
              repo.locks = await listLocks(status.path)
            } catch {
              repo.locks = []
            }
          }
          repos.push(repo)
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        })
        res.end(JSON.stringify({ home: getBrainTrainHome(), repos }))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(dashboardHTML)
  })

  return new Promise((resolve, reject) => {
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use. Try --port <number>.`))
      } else {
        reject(err)
      }
    })
    server.listen(port, () => {
      resolve({ server, port, url: `http://localhost:${port}` })
    })
  })
}
