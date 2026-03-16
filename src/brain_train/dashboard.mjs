import http from "node:http"
import { getStatus, listLocks, getBrainTrainHome } from "./core.mjs"

function buildDashboardHTML() {
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
    '  <script src="https://cdn.jsdelivr.net/npm/pixi.js@7.x/dist/pixi.min.js"></' + 'script>',
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
  --blue: #54a0ff;
  --blue-glow: rgba(84, 160, 255, 0.3);
  --orange: #ff9f43;
  --orange-glow: rgba(255, 159, 67, 0.2);
  --red: #ff6b6b;
  --font: 'Inter', -apple-system, system-ui, sans-serif;
  --mono: 'JetBrains Mono', monospace;
}
body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; overflow-x: hidden; }

/* Scene canvas */
#scene-container {
  position: fixed; top: 0; left: 0; right: 0; height: 380px;
  z-index: 0; overflow: hidden;
}
#scene-container canvas { display: block; }

/* Header */
.header {
  position: sticky; top: 0; padding: 1rem 2rem;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  background: rgba(8, 8, 16, 0.88); backdrop-filter: blur(24px); z-index: 100;
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
  width: 8px; height: 8px; border-radius: 50%; background: var(--green);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(0,214,143,0.4); }
  50% { opacity: 0.7; box-shadow: 0 0 0 8px rgba(0,214,143,0); }
}
.poll-label { font-size: 0.78rem; color: var(--text-dim); }

/* Main */
.main { position: relative; z-index: 1; padding: 2rem; padding-top: 410px; max-width: 1100px; margin: 0 auto; }

/* Repo */
.repo-section { margin-bottom: 3rem; }
.repo-header { margin-bottom: 1.25rem; }
.repo-name { font-size: 1.4rem; font-weight: 800; letter-spacing: -0.02em; }
.repo-path { font-family: var(--mono); font-size: 0.72rem; color: var(--text-dim); margin-top: 0.15rem; }

/* Train track for lane cards */
.train-track { position: relative; padding: 1.5rem 0; }
.train-track::before {
  content: ''; position: absolute; top: 50%; left: 0; right: 0;
  height: 4px; background: #2a2a44; transform: translateY(-50%); border-radius: 2px;
}

.lanes-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 1.25rem; position: relative; z-index: 1;
}

/* Lane card */
.lane-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 16px; padding: 1.5rem; position: relative;
  overflow: hidden; transition: all 0.4s ease;
}
.lane-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: var(--border); transition: background 0.5s, box-shadow 0.5s;
}
.lane-card:hover { background: var(--bg-card-hover); transform: translateY(-3px); }
.lane-card.status-in-progress::before { background: var(--blue); box-shadow: 0 0 20px var(--blue-glow), 0 0 60px var(--blue-glow); }
.lane-card.status-needs-review::before { background: var(--yellow); box-shadow: 0 0 20px var(--yellow-glow), 0 0 60px var(--yellow-glow); }
.lane-card.status-resolved::before { background: var(--green); box-shadow: 0 0 15px var(--green-glow); }
.lane-card.status-in-progress { border-color: rgba(84,160,255,0.25); box-shadow: 0 8px 40px rgba(84,160,255,0.08); animation: chug 0.6s ease-in-out infinite; }
.lane-card.status-needs-review { border-color: rgba(255,193,7,0.2); box-shadow: 0 8px 40px rgba(255,193,7,0.06); }
@keyframes chug { 0%,100%{transform:translateX(0)} 25%{transform:translateX(2px) translateY(-1px)} 75%{transform:translateX(-1px) translateY(0.5px)} }

.lane-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
.lane-id { font-family: var(--mono); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--accent); display: flex; align-items: center; gap: 0.4rem; }
.lane-id::before { content: '\\1F683'; font-size: 0.9rem; }
.status-badge { font-size: 0.65rem; font-weight: 600; padding: 0.25rem 0.7rem; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.05em; }
.badge-idle { background: rgba(120,120,160,0.1); color: var(--text-dim); border: 1px solid var(--border); }
.badge-in-progress { background: rgba(84,160,255,0.12); color: var(--blue); }
.badge-needs-review { background: rgba(255,193,7,0.12); color: var(--yellow); }
.badge-resolved { background: rgba(0,214,143,0.12); color: var(--green); }
.lane-task { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.85rem; min-height: 1.4em; line-height: 1.4; }
.lane-task.empty { color: var(--text-dim); font-weight: 400; font-style: italic; }
.lane-meta { display: flex; flex-direction: column; gap: 0.3rem; }
.meta-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.78rem; }
.meta-label { color: var(--text-dim); min-width: 62px; font-weight: 500; }
.meta-value { color: var(--text); }
.meta-value.dim { color: var(--text-dim); font-style: italic; }
.single-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; padding: 1.5rem; }

/* Locks */
.locks-section { margin-top: 1.25rem; }
.locks-title { font-size: 0.82rem; font-weight: 600; margin-bottom: 0.6rem; display: flex; align-items: center; gap: 0.5rem; }
.lock-count { font-size: 0.65rem; background: var(--orange-glow); color: var(--orange); padding: 0.12rem 0.5rem; border-radius: 20px; font-weight: 600; }
.lock-list { display: flex; flex-direction: column; gap: 0.35rem; }
.lock-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.78rem; font-family: var(--mono); background: rgba(255,159,67,0.05); padding: 0.4rem 0.75rem; border-radius: 8px; border: 1px solid rgba(255,159,67,0.1); }
.lock-lane-tag { font-size: 0.6rem; font-weight: 600; background: var(--accent-glow); color: var(--accent); padding: 0.08rem 0.4rem; border-radius: 4px; text-transform: uppercase; }
.lock-path { color: var(--orange); }
.lock-owner { color: var(--text-dim); font-family: var(--font); }
.error-banner { background: rgba(255,107,107,0.08); border: 1px solid rgba(255,107,107,0.2); border-radius: 8px; padding: 0.75rem 1rem; color: var(--red); font-size: 0.82rem; margin-bottom: 1.5rem; display: none; }
.empty-state { text-align: center; padding: 3rem 2rem; color: var(--text-dim); }
.empty-state h2 { font-size: 1.15rem; margin-bottom: 0.4rem; color: var(--text); }
@media (max-width: 600px) { .header{padding:0.75rem 1rem} .main{padding:1rem;padding-top:390px} .lanes-grid{grid-template-columns:1fr} }
`,
    '</style>',
    '</head>',
    '<body>',
    '',
    '<div id="scene-container"></div>',
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
// ═══════════════════════════════════════════════
// PixiJS Scene — Mountains, Towns, Train, Steam
// ═══════════════════════════════════════════════
var W, H = 380;
var sceneEl = document.getElementById("scene-container");
W = window.innerWidth;

var app = new PIXI.Application({ width: W, height: H, backgroundColor: 0x080810, antialias: true });
sceneEl.appendChild(app.view);

window.addEventListener("resize", function() {
  W = window.innerWidth;
  app.renderer.resize(W, H);
});

// ── Sky gradient ──
var skyGfx = new PIXI.Graphics();
function drawSky() {
  skyGfx.clear();
  // Deep night gradient
  skyGfx.beginFill(0x0a0a1a); skyGfx.drawRect(0, 0, W, H * 0.3); skyGfx.endFill();
  skyGfx.beginFill(0x0c1225); skyGfx.drawRect(0, H * 0.3, W, H * 0.3); skyGfx.endFill();
  skyGfx.beginFill(0x0e1830); skyGfx.drawRect(0, H * 0.6, W, H * 0.4); skyGfx.endFill();
}
drawSky();
app.stage.addChild(skyGfx);

// ── Stars ──
var starsContainer = new PIXI.Container();
var stars = [];
for (var i = 0; i < 120; i++) {
  var sg = new PIXI.Graphics();
  var sz = Math.random() * 2 + 0.5;
  sg.beginFill(0xffffff, Math.random() * 0.5 + 0.3);
  sg.drawCircle(0, 0, sz);
  sg.endFill();
  sg.x = Math.random() * W * 1.5;
  sg.y = Math.random() * H * 0.55;
  sg._twinkleSpeed = 0.02 + Math.random() * 0.03;
  sg._twinklePhase = Math.random() * Math.PI * 2;
  stars.push(sg);
  starsContainer.addChild(sg);
}
app.stage.addChild(starsContainer);

// ── Mountain glow overlay ──
var glowGfx = new PIXI.Graphics();
var glowAlpha = 0;
var glowTarget = 0;
app.stage.addChild(glowGfx);

function drawGlow() {
  glowGfx.clear();
  if (glowAlpha > 0.01) {
    glowGfx.beginFill(0x00d68f, glowAlpha * 0.15);
    glowGfx.drawRect(0, H * 0.2, W, H * 0.8);
    glowGfx.endFill();
  }
}

// ── Mountain layers (parallax) ──
function drawMountainLayer(container, peaks, color, offsetY) {
  var g = new PIXI.Graphics();
  g.beginFill(color);
  g.moveTo(0, H);
  for (var j = 0; j < peaks.length; j++) {
    g.lineTo(peaks[j][0], peaks[j][1] + offsetY);
  }
  g.lineTo(W * 2, H);
  g.closePath();
  g.endFill();
  container.addChild(g);
  return g;
}

var mtBack = new PIXI.Container();
var mtMid = new PIXI.Container();
var mtFront = new PIXI.Container();

// Back mountains (larger, dimmer)
var backPeaks = [[0,H],[W*0.08,H*0.25],[W*0.18,H*0.55],[W*0.30,H*0.2],[W*0.42,H*0.50],[W*0.55,H*0.15],[W*0.68,H*0.45],[W*0.80,H*0.22],[W*0.92,H*0.48],[W*1.05,H*0.18],[W*1.2,H]];
drawMountainLayer(mtBack, backPeaks, 0x0c0c22, 0);

// Mid mountains
var midPeaks = [[0,H],[W*0.05,H*0.55],[W*0.15,H*0.32],[W*0.28,H*0.60],[W*0.38,H*0.28],[W*0.52,H*0.55],[W*0.65,H*0.22],[W*0.75,H*0.50],[W*0.88,H*0.30],[W*1.0,H*0.55],[W*1.1,H]];
drawMountainLayer(mtMid, midPeaks, 0x10102a, 0);

// Front mountains
var frontPeaks = [[0,H],[W*0.1,H*0.45],[W*0.22,H*0.65],[W*0.35,H*0.38],[W*0.48,H*0.62],[W*0.6,H*0.35],[W*0.72,H*0.58],[W*0.85,H*0.40],[W*0.95,H*0.60],[W*1.1,H]];
drawMountainLayer(mtFront, frontPeaks, 0x141432, 0);

app.stage.addChild(mtBack);
app.stage.addChild(mtMid);
app.stage.addChild(mtFront);

// ── Ground strip ──
var ground = new PIXI.Graphics();
ground.beginFill(0x0a0a18);
ground.drawRect(0, H - 30, W * 2, 30);
ground.endFill();
app.stage.addChild(ground);

// ── Trees ──
var treesContainer = new PIXI.Container();
var treePositions = [0.03,0.09,0.16,0.24,0.31,0.38,0.45,0.53,0.61,0.68,0.74,0.81,0.88,0.95];
for (var t = 0; t < treePositions.length; t++) {
  var tg = new PIXI.Graphics();
  var tx = W * treePositions[t] + (Math.random()-0.5)*20;
  var th = 18 + Math.random() * 22;
  var tw = 8 + Math.random() * 6;
  // Trunk
  tg.beginFill(0x1a0e08);
  tg.drawRect(tx - 1.5, H - 30, 3, 8);
  tg.endFill();
  // Canopy (layered triangles)
  for (var layer = 0; layer < 3; layer++) {
    var ly = H - 30 - th + layer * (th * 0.3);
    var lw = tw * (1 - layer * 0.15);
    tg.beginFill(layer === 0 ? 0x0a2215 : layer === 1 ? 0x0c2a1a : 0x0e3520);
    tg.moveTo(tx, ly);
    tg.lineTo(tx + lw, ly + th * 0.45);
    tg.lineTo(tx - lw, ly + th * 0.45);
    tg.closePath();
    tg.endFill();
  }
  treesContainer.addChild(tg);
}
app.stage.addChild(treesContainer);

// ── Buildings / towns ──
var townsContainer = new PIXI.Container();
var townDefs = [
  {x: W*0.06, buildings: [{w:10,h:28},{w:14,h:38},{w:8,h:20}]},
  {x: W*0.35, buildings: [{w:12,h:25},{w:16,h:42},{w:10,h:30},{w:14,h:35}]},
  {x: W*0.58, buildings: [{w:8,h:22},{w:12,h:30}]},
  {x: W*0.78, buildings: [{w:14,h:32},{w:10,h:26},{w:16,h:40},{w:8,h:20}]},
];
for (var ti = 0; ti < townDefs.length; ti++) {
  var town = townDefs[ti];
  var bx = town.x;
  for (var bi = 0; bi < town.buildings.length; bi++) {
    var bd = town.buildings[bi];
    var bg = new PIXI.Graphics();
    bg.beginFill(0x0c0c1e);
    bg.drawRect(bx, H - 30 - bd.h, bd.w, bd.h);
    bg.endFill();
    // Windows
    for (var wy = 0; wy < Math.floor(bd.h / 10); wy++) {
      for (var wx = 0; wx < Math.floor(bd.w / 6); wx++) {
        if (Math.random() > 0.3) {
          var wg = new PIXI.Graphics();
          var winX = bx + 3 + wx * 6;
          var winY = H - 30 - bd.h + 5 + wy * 10;
          var lit = Math.random() > 0.2;
          wg.beginFill(lit ? 0xffeaa7 : 0x222230, lit ? 0.9 : 0.3);
          wg.drawRect(winX, winY, 3, 3);
          wg.endFill();
          if (lit) {
            wg._flicker = true;
            wg._flickerPhase = Math.random() * Math.PI * 2;
          }
          townsContainer.addChild(wg);
        }
      }
    }
    townsContainer.addChild(bg);
    bx += bd.w + 3;
  }
}
app.stage.addChild(townsContainer);

// ── Animals ──
var animalsContainer = new PIXI.Container();
var animalDefs = [
  {emoji:"🦌",x:W*0.12,s:18},
  {emoji:"🐻",x:W*0.25,s:16},
  {emoji:"🐇",x:W*0.40,s:13},
  {emoji:"🐸",x:W*0.50,s:11},
  {emoji:"🦉",x:W*0.67,s:14},
  {emoji:"🦊",x:W*0.85,s:14},
  {emoji:"🐿",x:W*0.72,s:12},
];
var animalSprites = [];
for (var ai = 0; ai < animalDefs.length; ai++) {
  var ad = animalDefs[ai];
  var at = new PIXI.Text(ad.emoji, {fontSize: ad.s});
  at.x = ad.x;
  at.y = H - 30 - ad.s - (ad.emoji === "🦉" ? 25 : 2);
  at.alpha = 0.3;
  at._baseAlpha = 0.3;
  animalSprites.push(at);
  animalsContainer.addChild(at);
}
app.stage.addChild(animalsContainer);

// ── Railroad track ──
var trackGfx = new PIXI.Graphics();
trackGfx.beginFill(0x2a2a44);
trackGfx.drawRect(0, H - 8, W, 4);
trackGfx.endFill();
// Rails
trackGfx.lineStyle(1, 0x3a3a5a);
trackGfx.moveTo(0, H - 8); trackGfx.lineTo(W, H - 8);
trackGfx.moveTo(0, H - 5); trackGfx.lineTo(W, H - 5);
// Ties
for (var ti2 = 0; ti2 < W; ti2 += 18) {
  trackGfx.lineStyle(2, 0x222240);
  trackGfx.moveTo(ti2, H - 10);
  trackGfx.lineTo(ti2, H - 3);
}
app.stage.addChild(trackGfx);

// ═══════════════════════
// THE TRAIN
// ═══════════════════════
var trainContainer = new PIXI.Container();
trainContainer.y = 0;
trainContainer.x = -300;

function drawWheel(parent, cx, cy, r) {
  var wh = new PIXI.Graphics();
  wh.beginFill(0x333344);
  wh.drawCircle(cx, cy, r);
  wh.endFill();
  wh.lineStyle(1, 0x555566);
  wh.drawCircle(cx, cy, r);
  // Spokes
  wh.lineStyle(0.5, 0x444455);
  for (var sp = 0; sp < 4; sp++) {
    var ang = sp * Math.PI / 2;
    wh.moveTo(cx, cy);
    wh.lineTo(cx + Math.cos(ang) * r * 0.8, cy + Math.sin(ang) * r * 0.8);
  }
  wh._cx = cx; wh._cy = cy; wh._r = r;
  parent.addChild(wh);
  return wh;
}

// Headlight beam
var beam = new PIXI.Graphics();
beam.beginFill(0xfff8dc, 0.04);
beam.moveTo(0, 0);
beam.lineTo(280, -35);
beam.lineTo(280, 35);
beam.closePath();
beam.endFill();
beam.beginFill(0xfff8dc, 0.08);
beam.moveTo(0, 0);
beam.lineTo(150, -18);
beam.lineTo(150, 18);
beam.closePath();
beam.endFill();
beam.x = 80; beam.y = H - 28;
trainContainer.addChild(beam);

// Locomotive body
var loco = new PIXI.Graphics();
// Boiler
loco.beginFill(0x2d1b4e);
loco.drawRoundedRect(0, H - 52, 65, 35, 4);
loco.endFill();
loco.lineStyle(1, 0x4d3b6e);
loco.drawRoundedRect(0, H - 52, 65, 35, 4);
// Boiler bands
loco.lineStyle(1, 0x3d2b5e);
loco.moveTo(15, H-52); loco.lineTo(15, H-17);
loco.moveTo(35, H-52); loco.lineTo(35, H-17);
loco.moveTo(50, H-52); loco.lineTo(50, H-17);
// Cowcatcher
loco.lineStyle(0);
loco.beginFill(0x1a0e30);
loco.moveTo(65, H-17);
loco.lineTo(78, H-12);
loco.lineTo(78, H-8);
loco.lineTo(65, H-8);
loco.closePath();
loco.endFill();
// Cabin
loco.beginFill(0x2d1b4e);
loco.drawRect(-5, H - 70, 24, 22);
loco.endFill();
loco.lineStyle(1, 0x4d3b6e);
loco.drawRect(-5, H - 70, 24, 22);
// Cabin roof
loco.lineStyle(0);
loco.beginFill(0x1a0e30);
loco.drawRect(-8, H - 73, 30, 4);
loco.endFill();
// Cabin window (warm glow)
loco.beginFill(0xffc864, 0.7);
loco.drawRect(-1, H - 66, 16, 10);
loco.endFill();
// Smokestack
loco.beginFill(0x1a0e30);
loco.drawRect(50, H - 68, 8, 18);
loco.endFill();
loco.beginFill(0x2d1b4e);
loco.drawRect(47, H - 72, 14, 5);
loco.endFill();
// Headlight
loco.beginFill(0xfff8dc);
loco.drawCircle(74, H - 28, 4);
loco.endFill();
trainContainer.addChild(loco);

// Locomotive wheels
var locoWheels = [];
locoWheels.push(drawWheel(trainContainer, 10, H-8, 7));
locoWheels.push(drawWheel(trainContainer, 30, H-8, 9));
locoWheels.push(drawWheel(trainContainer, 52, H-8, 9));

// Tender
var tender = new PIXI.Graphics();
tender.beginFill(0x1a1030);
tender.drawRect(-30, H - 42, 28, 28);
tender.endFill();
tender.lineStyle(1, 0x3d2b5e);
tender.drawRect(-30, H - 42, 28, 28);
// Coal
tender.lineStyle(0);
tender.beginFill(0x0a0614);
tender.drawRect(-27, H - 39, 22, 10);
tender.endFill();
trainContainer.addChild(tender);
drawWheel(trainContainer, -22, H-8, 6);
drawWheel(trainContainer, -10, H-8, 6);

// Cars
function drawCar(xOff, color, numWindows) {
  var car = new PIXI.Graphics();
  car.beginFill(color);
  car.drawRoundedRect(xOff, H - 38, 48, 24, 3);
  car.endFill();
  car.lineStyle(1, 0x3a4a6e);
  car.drawRoundedRect(xOff, H - 38, 48, 24, 3);
  // Windows
  car.lineStyle(0);
  for (var wi = 0; wi < numWindows; wi++) {
    car.beginFill(0xffc864, 0.3);
    car.drawRect(xOff + 6 + wi * 11, H - 34, 7, 7);
    car.endFill();
  }
  trainContainer.addChild(car);
  drawWheel(trainContainer, xOff + 10, H-8, 5);
  drawWheel(trainContainer, xOff + 38, H-8, 5);
}
drawCar(-82, 0x1b2a4a, 3);
drawCar(-134, 0x1b2a4a, 4);

// Caboose
var cab = new PIXI.Graphics();
cab.beginFill(0x4a1b2a);
cab.drawRoundedRect(-180, H - 38, 40, 24, 3);
cab.endFill();
cab.lineStyle(1, 0x6e3a4a);
cab.drawRoundedRect(-180, H - 38, 40, 24, 3);
// Cupola
cab.lineStyle(0);
cab.beginFill(0x4a1b2a);
cab.drawRect(-170, H - 50, 18, 14);
cab.endFill();
cab.lineStyle(1, 0x6e3a4a);
cab.drawRect(-170, H - 50, 18, 14);
// Caboose window
cab.lineStyle(0);
cab.beginFill(0xffc864, 0.3);
cab.drawRect(-166, H - 46, 10, 6);
cab.endFill();
trainContainer.addChild(cab);
drawWheel(trainContainer, -170, H-8, 5);
drawWheel(trainContainer, -148, H-8, 5);

// Tail light
var tailLight = new PIXI.Graphics();
tailLight.beginFill(0xff4444);
tailLight.drawCircle(-180, H - 26, 3);
tailLight.endFill();
trainContainer.addChild(tailLight);

app.stage.addChild(trainContainer);

// ═══════════════════════
// STEAM PARTICLES
// ═══════════════════════
var steamParticles = [];
var steamContainer = new PIXI.Container();
app.stage.addChild(steamContainer);

function emitSteam() {
  var p = new PIXI.Graphics();
  var sz = 3 + Math.random() * 5;
  p.beginFill(0xccccdd, 0.25);
  p.drawCircle(0, 0, sz);
  p.endFill();
  p.x = trainContainer.x + 54;
  p.y = H - 74;
  p._vx = -0.3 - Math.random() * 0.8;
  p._vy = -0.8 - Math.random() * 1.2;
  p._life = 1.0;
  p._decay = 0.008 + Math.random() * 0.01;
  p._growRate = 1.01 + Math.random() * 0.015;
  steamParticles.push(p);
  steamContainer.addChild(p);
}

// ═══════════════════════
// ANIMATION LOOP
// ═══════════════════════
var trainSpeed = 1.8;
var elapsed = 0;
var steamTimer = 0;

app.ticker.add(function(delta) {
  elapsed += delta;
  steamTimer += delta;

  // Stars twinkle
  for (var si = 0; si < stars.length; si++) {
    var st = stars[si];
    st.alpha = 0.2 + 0.6 * Math.abs(Math.sin(elapsed * st._twinkleSpeed + st._twinklePhase));
  }

  // Mountain glow
  glowAlpha += (glowTarget - glowAlpha) * 0.02;
  drawGlow();

  // Move train
  trainContainer.x += trainSpeed * delta;
  if (trainContainer.x > W + 350) {
    trainContainer.x = -350;
  }

  // Train bob
  trainContainer.y = Math.sin(elapsed * 0.15) * 1.2;

  // Tail light blink
  tailLight.alpha = 0.4 + 0.6 * Math.abs(Math.sin(elapsed * 0.05));

  // Illuminate animals near train
  var headX = trainContainer.x + 74;
  for (var ani = 0; ani < animalSprites.length; ani++) {
    var a = animalSprites[ani];
    var dist = a.x - headX;
    if (dist > -40 && dist < 320) {
      var intensity = 1.0 - Math.abs(dist - 140) / 180;
      a.alpha = Math.min(1, 0.3 + Math.max(0, intensity) * 0.7);
    } else {
      a.alpha += (0.3 - a.alpha) * 0.05;
    }
  }

  // Window flickering
  var children = townsContainer.children;
  for (var ci = 0; ci < children.length; ci++) {
    var ch = children[ci];
    if (ch._flicker) {
      ch.alpha = 0.5 + 0.5 * Math.abs(Math.sin(elapsed * 0.02 + ch._flickerPhase));
    }
  }

  // Emit steam
  if (steamTimer > 2) {
    steamTimer = 0;
    emitSteam();
    if (Math.random() > 0.3) emitSteam();
  }

  // Update steam particles
  for (var pi = steamParticles.length - 1; pi >= 0; pi--) {
    var sp = steamParticles[pi];
    sp.x += sp._vx * delta;
    sp.y += sp._vy * delta;
    sp._vy *= 0.995;
    sp._life -= sp._decay * delta;
    sp.alpha = sp._life * 0.3;
    sp.scale.x *= sp._growRate;
    sp.scale.y *= sp._growRate;
    if (sp._life <= 0) {
      steamContainer.removeChild(sp);
      sp.destroy();
      steamParticles.splice(pi, 1);
    }
  }
});

// ═══════════════════════
// DASHBOARD DATA LOGIC
// ═══════════════════════
var POLL_MS = 3000;
var lastJson = "";

function esc(s) {
  var d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
function badgeClass(status) { return "badge-" + (status || "idle").replace(/\\s+/g, "-"); }
function cardStatusClass(status) { return "status-" + (status || "idle").replace(/\\s+/g, "-"); }

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

function render(data) {
  if (!data.repos || data.repos.length === 0) {
    document.getElementById("content").innerHTML =
      '<div class="empty-state"><h2>No repos registered</h2><p>Run <code>btrain init /path/to/repo</code></p></div>';
    return;
  }

  // Update mountain glow based on active lanes
  var anyActive = data.repos.some(function(r) {
    if (r.lanes) return r.lanes.some(function(l) { return l.status === "in-progress" || l.status === "needs-review"; });
    return r.current && (r.current.status === "in-progress" || r.current.status === "needs-review");
  });
  glowTarget = anyActive ? 1.0 : 0.0;

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
      + '<div class="repo-header"><div class="repo-name">' + esc(repo.name) + '</div><div class="repo-path">' + esc(repo.path) + '</div></div>'
      + lanesHtml + renderLocks(repo.locks) + '</div>';
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
    if (json !== lastJson) { lastJson = json; render(data); }
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
