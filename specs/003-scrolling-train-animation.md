# Spec: Scrolling Train Animation — World Village Scene

**Status**: In Progress
**Version**: 1.0.0
**Author**: btrain
**Date**: 2026-03-16

## Summary

The `btrain dashboard` renders a side-scrolling Phaser 3 scene above the lane cards. A pixel-art train travels through a looping world of 15 culturally-diverse villages, with parallax mountains, ambient effects, and data-driven glow tied to lane activity.

## Scene Layout (depth-sorted, back → front)

| Depth | Layer | Scroll Rate | Details |
|---|---|---|---|
| 0 | **Mountains** | 0.15× (parallax) | Tiled sprite, wraps seamlessly |
| 1 | **Mountain glow** | static | Green overlay, alpha driven by lane activity |
| 2 | **Starfield** | static | 80–120 sprites, random twinkle (alpha oscillation) |
| 5 | **Ground strip** | static | Dark rectangle masking sprite bases |
| 6 | **Trees** | 0.4× | Pine/deciduous sprites spaced along ground |
| 7 | **Villages** | 0.7× | 15 village sprites placed along a 6000px virtual world |
| 8 | **Animals** | static | Emoji text sprites, headlight-reactive alpha |
| 9 | **Railroad track** | 1× | Drawn rails + ties at `GROUND_Y` |
| 10 | **Headlight beam** | with train | Triangle cone, illuminates villages + animals |
| 14 | **Train cars** | 1× | Trailing the locomotive |
| 15 | **Locomotive** | 1× | Scrolls right, loops at world width |
| 16 | **Steam puffs** | with train | Particle-like graphics, drift + fade |
| 16 | **Tail light** | with train | Blinking red glow on last car |
| 17 | **Fireflies** | drift | 15–20 small dots near villages, gentle glow |

## Virtual World

The scene uses `tilePositionX` for mountains/trees and explicit `x` offsets for village sprites. All scenery is placed along a **6000px virtual world** that loops when the train reaches the end.

```
World position:   0 -------- 400 -------- 800 -------- ... -------- 5600 -------- 6000
                  |           |           |                         |              |
                Alpine    Japanese    Moroccan   ...            Steampunk       (loop)
```

Each village sprite is an `Image` placed at a fixed world-X, anchored bottom-center to `GROUND_Y`. Scale is `0.10–0.14` (randomized slightly per village for organic feel).

## Train Motion

- Train scrolls right at `trainSpeed` pixels/frame (default 1.5)
- Position loops: when `trainX > WORLD_WIDTH`, reset to `-600`
- Camera viewport scrolls with train: `bg1.tilePositionX += 0.15`, tree/village positions shift by their parallax rate
- Vertical bob: `Math.sin(time * 0.003) * 2`

## Ambient Effects

### Starfield
- 80–120 `fillCircle` calls in a pre-rendered graphics layer
- Each star has an independent `phase` and `speed` for alpha oscillation: `alpha = 0.3 + 0.7 * Math.abs(Math.sin(time * speed + phase))`
- Stars are placed in the upper 60% of the canvas

### Fireflies
- 15–20 small circles (radius 2–4px) with warm yellow/green fill
- Drift: `x += Math.sin(time * freq + phase) * 0.3`, `y += Math.cos(time * freq2) * 0.2`
- Alpha oscillates gently between 0.1 and 0.6
- Positioned near village clusters

### Window Flicker
- For each village, 2–4 small orange rectangles overlaid at fixed offsets
- Alpha oscillates randomly: `0.3 + Math.random() * 0.4` (updated every ~10 frames to avoid flashing)

### Steam Puffs (existing)
- Spawned from smokestack at `trainX + locoW * 0.7`
- Physics: drift left (`vx: -0.3 – random * 0.6`), rise (`vy: -0.5 – random * 1.0`)
- Grow (`r *= 1.005+`) and fade (`life -= 0.006+`)

## Data-Driven Glow

`window.setMountainGlow(active)` is called by the dashboard data layer:
- `active = true` when **any lane** is `in-progress` or `needs-review`
- Smoothly animates green overlay alpha to `0.08` (active) or `0` (idle)

## Village Sprite Inventory (15 total)

| Key | Culture | File |
|---|---|---|
| `buildings` | English townhouses | `buildings.png` |
| `swiss` | Alpine Swiss chalets | `swiss.png` |
| `japanese` | Japanese temple town | `japanese.png` |
| `futuristic` | Futuristic city | `futuristic.png` |
| `tuscan` | Tuscan Italian | `tuscan.png` |
| `nordic` | Nordic Viking | `nordic.png` |
| `greek` | Greek island | `greek.png` |
| `cyberpunk` | Cyberpunk neon city | `cyberpunk.png` |
| `celtic` | Celtic Irish | `celtic.png` |
| `english` | English countryside | `english.png` |
| `indian` | Indian temple town | `indian.png` |
| `mexican` | Mexican colonial | `mexican.png` |
| `russian` | Russian village | `russian.png` |
| `thai` | Thai river village | `thai.png` |
| `egyptian` | Egyptian oasis | `egyptian.png` |
| `steampunk` | Steampunk Victorian | `steampunk.png` |

> Note: `buildings.png` (the original generic buildings) is retained alongside `english.png` (English countryside) for variety — they depict different architectural styles.

## Assets

All sprites live in `src/brain_train/assets/` and are served at `/assets/<filename>` by the dashboard HTTP server.

## Performance

- Target: 60fps at 1920×420 canvas
- Max particle count: 50 steam puffs (old ones culled when `life <= 0`)
- Village sprites are static `Image` objects (no per-frame redraws)
- Stars and fireflies use a single shared `Graphics` object cleared+redrawn each frame

## Backward Compatibility

- `dashboard.mjs` remains a single self-contained file (HTML + CSS + JS + server)
- No npm dependencies added — Phaser 3 loaded from CDN
- Existing `/api/state` endpoint unchanged
- Lane card rendering unchanged
