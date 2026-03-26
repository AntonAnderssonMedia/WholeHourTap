# WholeHourTap

[![Open Site](https://img.shields.io/badge/Android-DEMO-brightgreen?style=for-the-badge)](https://antonanderssonmedia.github.io/WholeHourTap/)

WebXR AR visualization that places a city map as a plane and renders **all bus trips within 20:00–21:00** as elevated 3D polylines. You can **tap a trip to highlight it** and filter what time-window is shown.

## What it does

- **AR map placement**: place a \(3.2m × 2.4m\) map plane on a detected surface (hit-test).
- **Trip rendering**: draws each `trip_id` as a “fat line” (`Line2`) above the map.
- **Tap-to-inspect** (placement OFF): tap a trip line to highlight it and show a small detail overlay (date/time/trip id/speed when available).
- **Filters & toggles**:
  - Map surface on/off
  - Roads overlay on/off
  - Height mode: **Trip** (relative to longest trip duration) vs **20–21** (absolute clock mapping)
  - Time-window slider within **20:00–21:00**
  - Point sampling density control (for performance)

## Requirements

- **WebXR AR**: Chrome on Android with ARCore support (needs `immersive-ar`).
- **Serving over HTTPS**: for AR on a physical device, you generally need **HTTPS** (or a trusted local setup). Desktop can still be used to sanity-check loading/UI, but AR won’t work there.

## Data / assets used

These files are loaded by `main.js` via `fetch()` or the texture loader, so they must be served from the same origin:

- `bus_data_trimmed.geojson` (trip points; expects `properties.trip_id`, `properties.time`, optional `properties.speed_value`)
- `OSMroads-nkpg-new.geojson` (road polylines; supports CRS84/WGS84 or EPSG:3006 detection)
- `viscenter-norrkoping-map.png` (map texture)

## Run locally

### Option A: quick local server (desktop sanity-check)

```bash
npx http-server . -p 8080
```

Open `http://localhost:8080` and verify the page loads. (AR will likely show as unsupported on desktop.)

### Option B: HTTPS for on-device WebXR AR

You need to serve the project over HTTPS and open it on your Android device in Chrome.

One common approach:

1. Create a local certificate (for example with `mkcert`) and place it under `certs/`
2. Start an HTTPS static server using that cert/key
3. Visit the HTTPS URL from your phone (same network), accept/trust the cert as needed, then tap **Enter AR**

Notes:
- `certs/` exists in this repo but is currently empty.
- If you deploy these static files to any HTTPS host (GitHub Pages, Netlify, etc.), WebXR AR on-device is usually the smoothest.

## Project structure

- `index.html`: UI overlays + loads `main.js`
- `main.js`: WebXR session, placement, rendering, filtering, tap-to-inspect
- `style.css`: overlay UI styling

## Controls (in AR)

- **Enter AR**: starts an `immersive-ar` session.
- **Placement: ON/OFF**: ON = move/place the map plane; OFF = tap to inspect/highlight trips.
- **Map / Roads / Timelines**: visibility toggles.
- **Height: Trip / Height: 20–21**: toggles height mapping.
- **From/To sliders**: filter within the 20:00–21:00 window.
