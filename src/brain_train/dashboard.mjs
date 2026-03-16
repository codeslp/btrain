import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getStatus, listLocks, getBrainTrainHome } from "./core.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.join(__dirname, "assets")

function buildDashboardHTML() {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <title>btrain \u2014 Lane Dashboard</title>',
    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">',
    '  <script src="https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.min.js"></' + 'script>',
    '<style>',
    `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #080810; --bg-card: #10101c; --bg-card-hover: #161628;
  --border: #1e1e38; --text: #e4e4ef; --text-dim: #7878a0;
  --accent: #6c5ce7; --accent-glow: rgba(108,92,231,0.2);
  --green: #00d68f; --green-glow: rgba(0,214,143,0.35);
  --yellow: #ffc107; --yellow-glow: rgba(255,193,7,0.3);
  --blue: #54a0ff; --blue-glow: rgba(84,160,255,0.3);
  --orange: #ff9f43; --orange-glow: rgba(255,159,67,0.2);
  --red: #ff6b6b;
  --font: 'Inter', -apple-system, system-ui, sans-serif;
  --mono: 'JetBrains Mono', monospace;
}
body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; overflow-x: hidden; }
#scene-container { position: fixed; top: 0; left: 0; right: 0; height: 420px; z-index: 0; overflow: hidden; }
#scene-container canvas { display: block; }
.header {
  position: sticky; top: 0; padding: 1rem 2rem;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  background: rgba(8,8,16,0.88); backdrop-filter: blur(24px); z-index: 100;
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
.pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(0,214,143,0.4)} 50%{opacity:0.7;box-shadow:0 0 0 8px rgba(0,214,143,0)} }
.poll-label { font-size: 0.78rem; color: var(--text-dim); }
.main { position: relative; z-index: 1; padding: 2rem; padding-top: 450px; max-width: 1100px; margin: 0 auto; }
.repo-section { margin-bottom: 3rem; }
.repo-header { margin-bottom: 1.25rem; }
.repo-name { font-size: 1.4rem; font-weight: 800; letter-spacing: -0.02em; }
.repo-path { font-family: var(--mono); font-size: 0.72rem; color: var(--text-dim); margin-top: 0.15rem; }
.train-track { position: relative; padding: 1.5rem 0; }
.train-track::before { content:''; position:absolute; top:50%; left:0; right:0; height:4px; background:#2a2a44; transform:translateY(-50%); border-radius:2px; }
.lanes-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 1.25rem; position: relative; z-index: 1; }
.lane-card {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px;
  padding: 1.5rem; position: relative; overflow: hidden; transition: all 0.4s ease;
}
.lane-card::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; background:var(--border); transition:background 0.5s, box-shadow 0.5s; }
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
@media(max-width:600px){.header{padding:0.75rem 1rem}.main{padding:1rem;padding-top:440px}.lanes-grid{grid-template-columns:1fr}}
`,
    '</style>',
    '</head>',
    '<body>',
    '',
    '<div id="scene-container"></div>',
    '',
    '<header class="header">',
    '  <div class="header-left">',
    '    <div class="logo"><span class="logo-icon">\u26A1</span> btrain</div>',
    '    <span class="header-badge">Lane Dashboard</span>',
    '  </div>',
    '  <div class="header-right">',
    '    <div class="pulse-dot"></div>',
    '    <span class="poll-label">Live \u00B7 3s</span>',
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
var W = window.innerWidth;
var H = 420;
var GROUND_Y = H - 35;
var WORLD_W = 172800; // ~2 minutes between villages at 1.5px/frame × 60fps

// Village definitions — spaced ~10800px apart along the virtual world
var VILLAGE_DEFS = [
  { key: "buildings",  worldX: 800,    scale: 0.13 },
  { key: "swiss",      worldX: 11600,  scale: 0.12 },
  { key: "japanese",   worldX: 22400,  scale: 0.12 },
  { key: "tuscan",     worldX: 33200,  scale: 0.12 },
  { key: "nordic",     worldX: 44000,  scale: 0.12 },
  { key: "greek",      worldX: 54800,  scale: 0.11 },
  { key: "cyberpunk",  worldX: 65600,  scale: 0.11 },
  { key: "celtic",     worldX: 76400,  scale: 0.12 },
  { key: "english",    worldX: 87200,  scale: 0.12 },
  { key: "indian",     worldX: 98000,  scale: 0.12 },
  { key: "mexican",    worldX: 108800, scale: 0.12 },
  { key: "russian",    worldX: 119600, scale: 0.12 },
  { key: "thai",       worldX: 130400, scale: 0.12 },
  { key: "egyptian",   worldX: 141200, scale: 0.12 },
  { key: "steampunk",  worldX: 152000, scale: 0.12 },
  { key: "futuristic", worldX: 162800, scale: 0.11 },
];

// Tree positions — 200 trees spread across the world for dense forests between villages
var TREE_WORLD_XS = [];
for (var _ti = 0; _ti < 200; _ti++) {
  TREE_WORLD_XS.push(Math.random() * WORLD_W);
}
TREE_WORLD_XS.sort(function(a,b){return a-b;});

// Animal definitions — scattered throughout the world between villages
var ANIMAL_POOL = [
  "\ud83e\udd8c", "\ud83d\udc3b", "\ud83d\udc07", "\ud83d\udc38",
  "\ud83e\udd89", "\ud83e\udd8a", "\ud83d\udc3f\ufe0f", "\ud83d\udc3a",
  "\ud83e\udda5", "\ud83e\udd94", "\ud83d\udc22", "\ud83e\udda8",
];
var ANIMAL_DEFS = [];
for (var _ai = 0; _ai < 60; _ai++) {
  ANIMAL_DEFS.push({
    ch: ANIMAL_POOL[Math.floor(Math.random() * ANIMAL_POOL.length)],
    worldX: Math.random() * WORLD_W,
    s: 13 + Math.floor(Math.random() * 8),
  });
}
ANIMAL_DEFS.sort(function(a,b){return a.worldX - b.worldX;});

// Phaser 3 scene
var TrainScene = new Phaser.Class({
  Extends: Phaser.Scene,
  initialize: function TrainScene() {
    Phaser.Scene.call(this, { key: "TrainScene" });
    this.trainWorldX = -500;
    this.trainSpeed = 1.5;
    this.glowActive = false;
    this.glowAlpha = 0;
    this.villageSprites = [];
    this.treeSprites = [];
    this.animalSprites = [];
    this.stars = [];
    this.fireflies = [];
    this.steamPuffs = [];
    this.windowFlickers = [];
  },
  preload: function() {
    var v = "?v=" + Date.now(); // Cache-busting
    this.load.image("mountains", "/assets/mountains.png" + v);
    this.load.image("train", "/assets/train.png" + v);
    this.load.image("cars", "/assets/cars.png" + v);
    this.load.image("trees", "/assets/trees.png" + v);
    // Load all village sprites
    var villageKeys = ["buildings","swiss","japanese","futuristic","tuscan","nordic","greek","cyberpunk","celtic","english","indian","mexican","russian","thai","egyptian","steampunk"];
    for (var vi = 0; vi < villageKeys.length; vi++) {
      this.load.image(villageKeys[vi], "/assets/" + villageKeys[vi] + ".png" + v);
    }
  },
  create: function() {
    var self = this;

    // --- Depth 0: Background mountains (tiled, parallax) ---
    this.bg1 = this.add.tileSprite(W/2, H/2, W, H, "mountains");
    this.bg1.setDisplaySize(W, H);
    this.bg1.setDepth(0);

    // --- Depth 1: Mountain glow overlay ---
    this.glowRect = this.add.rectangle(W/2, H/2, W, H, 0x00d68f, 0);
    this.glowRect.setDepth(1);

    // --- Depth 2: Starfield ---
    this.starGfx = this.add.graphics();
    this.starGfx.setDepth(2);
    for (var si = 0; si < 100; si++) {
      this.stars.push({
        x: Math.random() * W,
        y: Math.random() * H * 0.55,
        r: 0.5 + Math.random() * 1.2,
        phase: Math.random() * Math.PI * 2,
        speed: 0.001 + Math.random() * 0.003,
      });
    }

    // --- Depth 5: Ground strip ---
    this.groundRect = this.add.rectangle(W/2, GROUND_Y + 17, W, 34, 0x080810);
    this.groundRect.setDepth(5);

    // --- Depth 6: Trees (parallax 0.4x) ---
    for (var ti = 0; ti < TREE_WORLD_XS.length; ti++) {
      var treeScale = 0.08 + Math.random() * 0.06;
      var tree = this.add.image(0, GROUND_Y - 10, "trees");
      tree.setScale(treeScale);
      tree.setOrigin(0.5, 1);
      tree.setDepth(6);
      tree.setAlpha(0.6 + Math.random() * 0.4);
      tree._worldX = TREE_WORLD_XS[ti];
      this.treeSprites.push(tree);
    }

    // --- Depth 7: Villages (parallax 0.7x) ---
    for (var vi = 0; vi < VILLAGE_DEFS.length; vi++) {
      var vd = VILLAGE_DEFS[vi];
      var vSprite = this.add.image(0, GROUND_Y, vd.key);
      vSprite.setScale(vd.scale);
      vSprite.setOrigin(0.5, 1);
      vSprite.setDepth(7);
      vSprite._worldX = vd.worldX;
      vSprite._baseAlpha = 0.85;
      vSprite.setAlpha(0.85);
      this.villageSprites.push(vSprite);

      // Window flicker overlays for this village
      var flickerCount = 2 + Math.floor(Math.random() * 3);
      for (var fi = 0; fi < flickerCount; fi++) {
        this.windowFlickers.push({
          villageIdx: vi,
          offX: (Math.random() - 0.5) * 40 * vd.scale,
          offY: -(20 + Math.random() * 50) * vd.scale,
          w: 3 + Math.random() * 4,
          h: 3 + Math.random() * 3,
          alpha: 0.3 + Math.random() * 0.4,
          nextFlicker: 0,
        });
      }
    }

    // --- Depth 8: Animals ---
    for (var ai = 0; ai < ANIMAL_DEFS.length; ai++) {
      var ad = ANIMAL_DEFS[ai];
      var isOwl = ad.ch === "\ud83e\udd89";
      var at = this.add.text(0, GROUND_Y - ad.s - (isOwl ? 30 : 4), ad.ch, { fontSize: ad.s + "px" });
      at.setDepth(8);
      at.setAlpha(0.25);
      at._worldX = ad.worldX;
      this.animalSprites.push(at);
    }

    // --- Depth 9: Railroad track ---
    this.trackGfx = this.add.graphics();
    this.trackGfx.setDepth(9);
    this._drawTrack();

    // --- Depth 10: Headlight ---
    this.headlightGfx = this.add.graphics();
    this.headlightGfx.setDepth(10);

    // --- Depth 14-15: Train (flipped to face right / forward) ---
    this.trainLoco = this.add.image(0, GROUND_Y - 5, "train");
    this.trainLoco.setScale(0.22);
    this.trainLoco.setFlipX(true);
    this.trainLoco.setOrigin(1, 1);
    this.trainLoco.setDepth(15);

    this.trainCars = this.add.image(0, GROUND_Y - 5, "cars");
    this.trainCars.setScale(0.22);
    this.trainCars.setFlipX(true);
    this.trainCars.setOrigin(0, 1);
    this.trainCars.setDepth(14);

    // --- Depth 16: Steam + tail light ---
    this.steamGfx = this.add.graphics();
    this.steamGfx.setDepth(16);

    this.tailGfx = this.add.graphics();
    this.tailGfx.setDepth(16);

    // --- Depth 17: Fireflies ---
    this.fireflyGfx = this.add.graphics();
    this.fireflyGfx.setDepth(17);
    for (var ffi = 0; ffi < 18; ffi++) {
      this.fireflies.push({
        worldX: Math.random() * WORLD_W,
        baseY: GROUND_Y - 30 - Math.random() * 100,
        phase: Math.random() * Math.PI * 2,
        freq: 0.0005 + Math.random() * 0.002,
        freq2: 0.0008 + Math.random() * 0.001,
        r: 1.5 + Math.random() * 2,
      });
    }

    // --- Depth 18: Vignette overlay ---
    this.vignetteGfx = this.add.graphics();
    this.vignetteGfx.setDepth(18);
    this._drawVignette();

    // Expose glow control
    window.setMountainGlow = function(active) { self.glowActive = active; };
  },

  _drawTrack: function() {
    this.trackGfx.clear();
    this.trackGfx.fillStyle(0x2a2a44, 1);
    this.trackGfx.fillRect(0, GROUND_Y - 2, W, 4);
    this.trackGfx.fillStyle(0x222240, 1);
    for (var ti = 0; ti < Math.ceil(W / 16); ti++) {
      this.trackGfx.fillRect(ti * 16, GROUND_Y - 5, 2, 10);
    }
  },

  _drawVignette: function() {
    this.vignetteGfx.clear();
    // Left edge vignette
    for (var vi = 0; vi < 60; vi++) {
      var a = (1 - vi / 60) * 0.4;
      this.vignetteGfx.fillStyle(0x080810, a);
      this.vignetteGfx.fillRect(vi, 0, 1, H);
    }
    // Right edge vignette
    for (var vr = 0; vr < 60; vr++) {
      var ar = (1 - vr / 60) * 0.4;
      this.vignetteGfx.fillStyle(0x080810, ar);
      this.vignetteGfx.fillRect(W - vr, 0, 1, H);
    }
  },

  // Convert world-X to screen-X with parallax
  _worldToScreen: function(worldX, parallax) {
    var camOffset = this.trainWorldX * parallax;
    var screenX = worldX - camOffset;
    // Wrap around the world
    screenX = ((screenX % WORLD_W) + WORLD_W) % WORLD_W;
    // Center in viewport: offset so train is roughly at screen center
    screenX = screenX - this.trainWorldX + W * 0.35;
    // Wrap to keep on screen vicinity
    while (screenX > WORLD_W * 0.6)  screenX -= WORLD_W;
    while (screenX < -WORLD_W * 0.4) screenX += WORLD_W;
    return screenX;
  },

  update: function(time, delta) {
    // === Parallax scroll background ===
    this.bg1.tilePositionX += 0.15;

    // === Mountain glow ===
    var targetAlpha = this.glowActive ? 0.08 : 0;
    this.glowAlpha += (targetAlpha - this.glowAlpha) * 0.02;
    this.glowRect.setAlpha(this.glowAlpha);

    // === Move train in world space ===
    this.trainWorldX += this.trainSpeed;
    if (this.trainWorldX > WORLD_W + 600) this.trainWorldX = -600;

    var bob = Math.sin(time * 0.003) * 2;
    var trainScreenX = W * 0.35; // Train stays at ~35% of screen
    var locoW = this.trainLoco.displayWidth;

    this.trainLoco.setPosition(trainScreenX, GROUND_Y - 5 + bob);
    this.trainCars.setPosition(trainScreenX - locoW, GROUND_Y - 5 + bob);

    // === Update village positions (0.7x parallax) ===
    for (var vi = 0; vi < this.villageSprites.length; vi++) {
      var vs = this.villageSprites[vi];
      var vScreenX = this._worldToScreen(vs._worldX, 0.7);
      vs.setPosition(vScreenX, GROUND_Y);
      vs.setVisible(vScreenX > -300 && vScreenX < W + 300);
    }

    // === Update tree positions (0.4x parallax) ===
    for (var ti = 0; ti < this.treeSprites.length; ti++) {
      var ts = this.treeSprites[ti];
      var tScreenX = this._worldToScreen(ts._worldX, 0.4);
      ts.setPosition(tScreenX, GROUND_Y - 10);
      ts.setVisible(tScreenX > -100 && tScreenX < W + 100);
    }

    // === Update animal positions (0.8x parallax) ===
    for (var ai = 0; ai < this.animalSprites.length; ai++) {
      var aSprite = this.animalSprites[ai];
      var aScreenX = this._worldToScreen(aSprite._worldX, 0.8);
      aSprite.setPosition(aScreenX, aSprite.y);
      aSprite.setVisible(aScreenX > -50 && aScreenX < W + 50);
    }

    // === Headlight beam (front of loco = trainScreenX, facing right) ===
    this.headlightGfx.clear();
    var hlX = trainScreenX;
    var hlY = GROUND_Y - 30 + bob;
    this.headlightGfx.fillStyle(0xfff8dc, 0.03);
    this.headlightGfx.fillTriangle(hlX, hlY, hlX + 280, hlY - 40, hlX + 280, hlY + 40);
    this.headlightGfx.fillStyle(0xfff8dc, 0.06);
    this.headlightGfx.fillTriangle(hlX, hlY, hlX + 140, hlY - 20, hlX + 140, hlY + 20);

    // === Illuminate animals near headlight ===
    for (var ai2 = 0; ai2 < this.animalSprites.length; ai2++) {
      var a = this.animalSprites[ai2];
      if (!a.visible) { a.setAlpha(a.alpha + (0.25 - a.alpha) * 0.04); continue; }
      var dist = a.x - hlX;
      if (dist > -50 && dist < 320) {
        var intensity = 1.0 - Math.abs(dist - 140) / 180;
        a.setAlpha(Math.min(1, 0.25 + Math.max(0, intensity) * 0.75));
      } else {
        a.setAlpha(a.alpha + (0.25 - a.alpha) * 0.04);
      }
    }

    // === Illuminate villages near headlight ===
    for (var vi2 = 0; vi2 < this.villageSprites.length; vi2++) {
      var vv = this.villageSprites[vi2];
      if (!vv.visible) continue;
      var vDist = vv.x - hlX;
      if (vDist > -100 && vDist < 400) {
        var vInt = 1.0 - Math.abs(vDist - 150) / 250;
        vv.setAlpha(Math.min(1, 0.85 + Math.max(0, vInt) * 0.15));
      } else {
        vv.setAlpha(vv.alpha + (0.85 - vv.alpha) * 0.03);
      }
    }

    // === Starfield ===
    this.starGfx.clear();
    for (var si = 0; si < this.stars.length; si++) {
      var star = this.stars[si];
      var starAlpha = 0.25 + 0.75 * Math.abs(Math.sin(time * star.speed + star.phase));
      this.starGfx.fillStyle(0xeeeeff, starAlpha);
      this.starGfx.fillCircle(star.x, star.y, star.r);
    }

    // === Fireflies ===
    this.fireflyGfx.clear();
    for (var fi = 0; fi < this.fireflies.length; fi++) {
      var ff = this.fireflies[fi];
      var ffScreenX = this._worldToScreen(ff.worldX, 0.7);
      if (ffScreenX < -50 || ffScreenX > W + 50) continue;
      var ffX = ffScreenX + Math.sin(time * ff.freq + ff.phase) * 15;
      var ffY = ff.baseY + Math.cos(time * ff.freq2 + ff.phase) * 10;
      var ffAlpha = 0.15 + 0.45 * Math.abs(Math.sin(time * ff.freq * 1.5 + ff.phase));
      // Outer glow
      this.fireflyGfx.fillStyle(0xaaff44, ffAlpha * 0.3);
      this.fireflyGfx.fillCircle(ffX, ffY, ff.r * 2.5);
      // Core
      this.fireflyGfx.fillStyle(0xeeff88, ffAlpha);
      this.fireflyGfx.fillCircle(ffX, ffY, ff.r);
    }

    // === Window flicker ===
    for (var wfi = 0; wfi < this.windowFlickers.length; wfi++) {
      var wf = this.windowFlickers[wfi];
      var wfVillage = this.villageSprites[wf.villageIdx];
      if (!wfVillage || !wfVillage.visible) continue;
      if (time > wf.nextFlicker) {
        wf.alpha = 0.2 + Math.random() * 0.5;
        wf.nextFlicker = time + 200 + Math.random() * 800;
      }
    }
    // Draw window flickers (use headlight graphics layer to avoid extra objects)
    for (var wfi2 = 0; wfi2 < this.windowFlickers.length; wfi2++) {
      var wf2 = this.windowFlickers[wfi2];
      var wfV = this.villageSprites[wf2.villageIdx];
      if (!wfV || !wfV.visible) continue;
      this.headlightGfx.fillStyle(0xffaa33, wf2.alpha * 0.4);
      this.headlightGfx.fillRect(
        wfV.x + wf2.offX - wf2.w/2,
        wfV.y + wf2.offY - wf2.h/2,
        wf2.w, wf2.h
      );
    }

    // === Steam puffs (from smokestack, near front of loco) ===
    if (Math.random() > 0.85) {
      this.steamPuffs.push({
        x: trainScreenX - locoW * 0.3,
        y: GROUND_Y - 60 + bob,
        r: 3 + Math.random() * 5,
        vx: -0.3 - Math.random() * 0.6,
        vy: -0.5 - Math.random() * 1.0,
        life: 1.0,
        decay: 0.006 + Math.random() * 0.008,
        grow: 1.005 + Math.random() * 0.008,
      });
    }
    this.steamGfx.clear();
    for (var pi = this.steamPuffs.length - 1; pi >= 0; pi--) {
      var sp = this.steamPuffs[pi];
      sp.x += sp.vx;
      sp.y += sp.vy;
      sp.vy *= 0.997;
      sp.life -= sp.decay;
      sp.r *= sp.grow;
      if (sp.life <= 0) {
        this.steamPuffs.splice(pi, 1);
        continue;
      }
      this.steamGfx.fillStyle(0xccccdd, sp.life * 0.25);
      this.steamGfx.fillCircle(sp.x, sp.y, sp.r);
    }

    // === Tail light blink (rear of last car) ===
    this.tailGfx.clear();
    var carsW = this.trainCars.displayWidth;
    var tailX = trainScreenX - locoW - carsW;
    var tailBrightness = 0.3 + 0.7 * Math.abs(Math.sin(time * 0.004));
    this.tailGfx.fillStyle(0xff4444, tailBrightness);
    this.tailGfx.fillCircle(tailX + 5, GROUND_Y - 22 + bob, 4);
    this.tailGfx.fillStyle(0xff4444, tailBrightness * 0.3);
    this.tailGfx.fillCircle(tailX + 5, GROUND_Y - 22 + bob, 8);
  },
});

var game = new Phaser.Game({
  type: Phaser.AUTO,
  width: W,
  height: H,
  parent: "scene-container",
  transparent: true,
  scene: [TrainScene],
  backgroundColor: "#080810",
  scale: { mode: Phaser.Scale.NONE },
  render: { antialias: true, pixelArt: false },
});

window.addEventListener("resize", function() {
  W = window.innerWidth;
  game.scale.resize(W, H);
});

// ============================
// DASHBOARD DATA
// ============================
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
    + '<div class="locks-title">\ud83d\udd12 File Locks <span class="lock-count">' + locks.length + '</span></div>'
    + '<div class="lock-list">' + items + '</div></div>';
}

function render(data) {
  if (!data.repos || data.repos.length === 0) {
    document.getElementById("content").innerHTML =
      '<div class="empty-state"><h2>No repos registered</h2><p>Run <code>btrain init /path/to/repo</code></p></div>';
    return;
  }
  var anyActive = data.repos.some(function(r) {
    if (r.lanes) return r.lanes.some(function(l) { return l.status === "in-progress" || l.status === "needs-review"; });
    return r.current && (r.current.status === "in-progress" || r.current.status === "needs-review");
  });
  if (window.setMountainGlow) window.setMountainGlow(anyActive);

  var html = data.repos.map(function(repo) {
    var lanesHtml = "";
    if (repo.lanes) {
      lanesHtml = '<div class="train-track"><div class="lanes-grid">'
        + repo.lanes.map(renderLaneCard).join("")
        + '</div></div>';
    } else { lanesHtml = renderSingleLane(repo); }
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
    '</' + 'script>',
    '</body>',
    '</html>',
  ].join('\n')

  return html
}

const MIME_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" }

export async function startDashboard({ port = 3456 } = {}) {
  const dashboardHTML = buildDashboardHTML()

  const server = http.createServer(async (req, res) => {
    // API endpoint
    if (req.url === "/api/state") {
      try {
        const statuses = await getStatus()
        const repos = []
        for (const status of statuses) {
          const repo = { ...status }
          if (status.locks === undefined && status.lanes) {
            try { repo.locks = await listLocks(status.path) } catch { repo.locks = [] }
          }
          repos.push(repo)
        }
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" })
        res.end(JSON.stringify({ home: getBrainTrainHome(), repos }))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // Static assets
    if (req.url.startsWith("/assets/")) {
      const urlPath = req.url.split("?")[0] // Strip query params (cache-busting)
      const fileName = path.basename(urlPath)
      const filePath = path.join(ASSETS_DIR, fileName)
      try {
        const data = fs.readFileSync(filePath)
        const ext = path.extname(fileName)
        res.writeHead(200, {
          "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
          "Cache-Control": "no-cache",
        })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end("Not found")
      }
      return
    }

    // Dashboard HTML
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
