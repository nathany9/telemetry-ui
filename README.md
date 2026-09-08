# Telemetry UI

Front-end dashboard for exploring motorsport telemetry. It pulls session, driver, and lap data from a Telemetry API so you can compare qualifying laps side by side with real-time playback and per-metric charts.

## What it does
- Browse seasons and events, then lock onto the qualifying session.
- Select up to three drivers and load their fastest lap telemetry.
- Compare every driver's fastest lap and sector times in qualifying order.
- Animate cars around the track with play/pause, scrubbing, zoom, and speed controls.
- See which selected drivers returned usable fastest-lap telemetry.
- View synchronized charts for speed, throttle, brake, and gear with a shared time cursor.

## Running it locally
Requirements: Node 18+ and npm.

1) Install dependencies:
```bash
npm install
```
2) (Optional) Point the UI at your own API by setting `VITE_API_BASE`. If unset, it falls back to the hosted Cloud Run backend which has limited domain access.
```bash
VITE_API_BASE=http://127.0.0.1:8000 npm run dev
```
3) Start the dev server:
```bash
npm run dev
```
4) Build for production:
```bash
npm run build
```
5) Preview the production build locally:
```bash
npm run preview
```
