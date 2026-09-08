import { useEffect, useMemo, useRef, useState } from "react";

type TelemetryPoint = {
  t: number;   // seconds from lap start
  x: number;   // meters (track-local coordinate, e.g., origin anywhere consistent)
  y: number;   // meters
  speed?: number; // m/s (optional)
};

type LapSeries = {
  driverId: string;
  color: string;        // hex or css color for legend
  displayName: string;  // e.g. "VER"
  points: TelemetryPoint[]; // MUST be sorted by t ascending
};

type Props = {
  series: LapSeries[];        // 1–3 drivers
  showTrailMeters?: number;   // length of trail to render, default 150m
  playbackRate?: number;      // 1 = real-time, 2 = 2x, default 1
  carLengthM?: number;        // default 5.6
  carWidthM?: number;         // default 2.0
  height?: number;            // canvas height px
  onTimeCursorChange?: (t: number) => void;
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function lerp(a: number, b: number, k: number) { return a + (b - a) * k; }

function interpolatePoint(a: TelemetryPoint, b: TelemetryPoint, t: number) {
  if (b.t === a.t) return { x: a.x, y: a.y };
  const k = (t - a.t) / (b.t - a.t);
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
}

function headingAt(points: TelemetryPoint[], t: number) {
  // small epsilon to compute forward diff
  const eps = 0.02;
  const p1 = sampleAt(points, t);
  const p2 = sampleAt(points, Math.min(points[points.length - 1].t, t + eps));
  return Math.atan2(p2.y - p1.y, p2.x - p1.x) || 0;
}

function sampleAt(points: TelemetryPoint[], t: number) {
  // binary search
  let lo = 0, hi = points.length - 1;
  if (t <= points[0].t) return { x: points[0].x, y: points[0].y };
  if (t >= points[hi].t) return { x: points[hi].x, y: points[hi].y };
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  return interpolatePoint(points[lo], points[hi], t);
}

function length2D(x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0, dy = y1 - y0;
  return Math.hypot(dx, dy);
}

export default function TelemetryAnimator({
  series,
  showTrailMeters = 150,
  playbackRate: initialPlaybackRate = 1,
  carLengthM = 5.6,
  carWidthM = 2.0,
  height = 520,
  onTimeCursorChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(true);
  const [timeCursor, setTimeCursor] = useState(0);
  const timeCursorRef = useRef(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [zoomFactor, setZoomFactor] = useState(1.5);
  const [playbackRate, setPlaybackRate] = useState(initialPlaybackRate);

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // Precompute total animation length (max t across series)
  const tMax = useMemo(() => {
    if (!series.length) return 0;
    return Math.max(...series.map(s => s.points.at(-1)!.t));
  }, [series]);

  // Camera state (world center and scale meters->pixels), smoothed
  const cam = useRef({ cx: 0, cy: 0, scale: 1 }); // scale px per meter

  // Colors for legend fallback
  const defaultColors = ["#22c55e", "#3b82f6", "#ef4444"];

  useEffect(() => {
    if (!series.length) return;
    let raf = 0;
    let last = performance.now();

    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;

      if (playing && !isScrubbing) {
        const current = timeCursorRef.current;
        const next = current + dt * playbackRate;
        const clamped = next >= tMax ? 0 : next;

        timeCursorRef.current = clamped;
        setTimeCursor(clamped);
        if (onTimeCursorChange) onTimeCursorChange(clamped);
      }

      draw();
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playbackRate, isScrubbing, tMax, series, zoomFactor]);

  function worldToScreen(x: number, y: number, W: number, H: number) {
    // y axis: +y up in world; canvas y is down, so invert
    const s = cam.current.scale;
    const cx = cam.current.cx;
    const cy = cam.current.cy;
    const sx = (x - cx) * s + W / 2;
    const sy = (-(y - cy)) * s + H / 2;
    return { x: sx, y: sy };
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    if (!series.length) {
      ctx.clearRect(0, 0, W, H);
      return;
    }

    const currentT = timeCursorRef.current;

    // Global track bounds (all points, all series) for stable zoom
    let globalMinX = Infinity, globalMaxX = -Infinity;
    let globalMinY = Infinity, globalMaxY = -Infinity;
    for (let i = 0; i < series.length; i++) {
      const pts = series[i].points;
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        if (p.x < globalMinX) globalMinX = p.x;
        if (p.x > globalMaxX) globalMaxX = p.x;
        if (p.y < globalMinY) globalMinY = p.y;
        if (p.y > globalMaxY) globalMaxY = p.y;
      }
    }
    if (!isFinite(globalMinX)) {
      globalMinX = 0; globalMaxX = 1;
      globalMinY = 0; globalMaxY = 1;
    }
    const trackW = (globalMaxX - globalMinX) || 1;
    const trackH = (globalMaxY - globalMinY) || 1;
    const baseScale = 7 * Math.min(W / trackW, H / trackH); // px per meter, stable for entire lap

    // Current car positions
    const carWorldPositions = series.map((s) => {
      const pos = sampleAt(s.points, clamp(currentT, 0, s.points.at(-1)!.t));
      const hdg = headingAt(s.points, currentT);
      return { driverId: s.driverId, color: s.color || defaultColors[0], ...pos, hdg };
    });

    // Compute camera target:
    // - center on the average car position
    // - use a stable global zoom based on the full track bbox
    let sumX = 0, sumY = 0;
    for (let i = 0; i < carWorldPositions.length; i++) {
      sumX += carWorldPositions[i].x;
      sumY += carWorldPositions[i].y;
    }
    const cxTarget = sumX / carWorldPositions.length;
    const cyTarget = sumY / carWorldPositions.length;

    const scaleTarget = clamp(baseScale * zoomFactor, 0.05, 8.0);

    // Smooth camera; keeps motion fluid without zoom pumping
    cam.current.cx = lerp(cam.current.cx, cxTarget, 0.2);
    cam.current.cy = lerp(cam.current.cy, cyTarget, 0.2);
    cam.current.scale = lerp(cam.current.scale, scaleTarget, 0.2);

    // Now that camera is updated for this frame, clear and draw everything
    ctx.clearRect(0, 0, W, H);

    // Draw full lap outline for each driver based on telemetry-derived track
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const pts = s.points;
      if (!pts.length) continue;

      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = "rgba(148, 163, 184, 0.6)"; // soft gray
      ctx.beginPath();

      const first = worldToScreen(pts[0].x, pts[0].y, W, H);
      ctx.moveTo(first.x, first.y);

      for (let j = 1; j < pts.length; j++) {
        const p = worldToScreen(pts[j].x, pts[j].y, W, H);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // Draw trails (last N meters) for each driver
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const color = s.color || defaultColors[i % defaultColors.length];

      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = color;
      ctx.beginPath();

      // Build trail polyline in time steps
      let t = currentT;
      const stepT = 0.02;
      const first = sampleAt(s.points, t);
      const firstScreen = worldToScreen(first.x, first.y, W, H);
      ctx.moveTo(firstScreen.x, firstScreen.y);

      let remaining = showTrailMeters;
      let lastX = first.x, lastY = first.y;

      for (let k = 0; k < 1500 && remaining > 0; k++) {
        t = Math.max(0, t - stepT);
        const p = sampleAt(s.points, t);
        const scr = worldToScreen(p.x, p.y, W, H);
        ctx.lineTo(scr.x, scr.y);
        remaining -= length2D(lastX, lastY, p.x, p.y);
        lastX = p.x; lastY = p.y;
        if (t <= 0) break;
      }
      ctx.stroke();
    }

    // Draw cars
    for (let i = 0; i < carWorldPositions.length; i++) {
      const car = carWorldPositions[i];
      const color = series[i].color || defaultColors[i % defaultColors.length];

      const s = cam.current.scale;
      const L = carLengthM * s;
      const Wcar = carWidthM * s;

      const p = worldToScreen(car.x, car.y, W, H);

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-car.hdg); // negate because screen y is inverted

      // Body
      ctx.fillStyle = color;
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.rect(-L * 0.5, -Wcar * 0.5, L, Wcar);
      ctx.fill();
      ctx.stroke();

      // Nose indicator (front)
      ctx.fillStyle = "white";
      ctx.fillRect(L * 0.25, -Wcar * 0.12, L * 0.08, Wcar * 0.24);

      ctx.restore();
    }

    // HUD: Legend + timeline
    ctx.save();
    ctx.font = `${12 * dpr}px ui-sans-serif, system-ui, -apple-system`;
    ctx.textBaseline = "top";
    let y = 10 * dpr;
    for (let i = 0; i < series.length; i++) {
      const color = series[i].color || defaultColors[i % defaultColors.length];
      ctx.fillStyle = color;
      ctx.fillRect(10 * dpr, y, 12 * dpr, 12 * dpr);
      ctx.fillStyle = "#fff";
      ctx.fillText(` ${series[i].displayName}`, 26 * dpr, y);
      y += 16 * dpr;
    }
    // Time readout
    ctx.fillStyle = "#bbb";
    ctx.fillText(`t = ${currentT.toFixed(2)}s / ${tMax.toFixed(2)}s`, 10 * dpr, y + 6 * dpr);
    ctx.restore();
  }

  // Resize canvas to DPR
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function onResize() {
      const canvasEl = canvasRef.current;
      if (!canvasEl) return;
      const parent = canvasEl.parentElement;
      const width = parent ? parent.clientWidth : 900;
      canvasEl.style.width = `${width}px`;
      canvasEl.style.height = `${height}px`;
      canvasEl.width = Math.floor(width * dpr);
      canvasEl.height = Math.floor(height * dpr);
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [height, dpr]);

  const handleScrub = (v: number) => {
    timeCursorRef.current = v;
    setTimeCursor(v);
    if (onTimeCursorChange) onTimeCursorChange(v);
  };

  return (
    <div className="w-full flex flex-col gap-3">
      <div className="rounded-xl bg-neutral-900 border border-neutral-800 overflow-hidden">
        <canvas ref={canvasRef} />
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2">
        {/* Top row: Play/Pause, step buttons, zoom, and playback speed */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPlaying(p => !p)}
            className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white"
          >
            {playing ? "Pause" : "Play"}
          </button>

          <button
            onClick={() =>
              setTimeCursor(c => {
                const next = clamp(c - 1 / 60, 0, tMax);
                timeCursorRef.current = next;
                if (onTimeCursorChange) onTimeCursorChange(next);
                return next;
              })
            }
            className="px-2 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white"
            title="Step back"
          >
            ◀︎
          </button>
          <button
            onClick={() =>
              setTimeCursor(c => {
                const next = clamp(c + 1 / 60, 0, tMax);
                timeCursorRef.current = next;
                if (onTimeCursorChange) onTimeCursorChange(next);
                return next;
              })
            }
            className="px-2 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white"
            title="Step forward"
          >
            ▶︎
          </button>
          <div className="flex items-center gap-1 ml-2">
            <button
              onClick={() =>
                setZoomFactor(z => clamp(z - 0.25, 0.25, 4))
              }
              className="px-2 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white text-xs"
              title="Zoom out"
            >
              -
            </button>
            <button
              onClick={() =>
                setZoomFactor(z => clamp(z + 0.25, 0.25, 4))
              }
              className="px-2 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white text-xs"
              title="Zoom in"
            >
              +
            </button>
            <span className="text-xs text-neutral-400 w-[56px] text-center">
              {zoomFactor.toFixed(2)}x
            </span>
          </div>
          <div className="flex items-center gap-1 ml-2">
            {([0.5, 1, 1.5] as const).map((rate) => {
              const isActive = playbackRate === rate;
              return (
                <button
                  key={rate}
                  onClick={() => setPlaybackRate(rate)}
                  className={
                    "px-2 py-1 rounded-lg text-xs " +
                    (isActive
                      ? "bg-neutral-100 text-neutral-900"
                      : "bg-neutral-800 hover:bg-neutral-700 text-white")
                  }
                >
                  {rate}x
                </button>
              );
            })}
          </div>
        </div>

        {/* Bottom row: Time scrubber and time display */}
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={tMax || 0}
            step={0.01}
            value={timeCursor}
            onMouseDown={() => setIsScrubbing(true)}
            onMouseUp={() => setIsScrubbing(false)}
            onChange={(e) => handleScrub(Number(e.target.value))}
            className="flex-1"
          />
          <div className="text-sm text-neutral-300 min-w-[80px] text-right">
            {timeCursor.toFixed(2)}s
          </div>
        </div>
      </div>
    </div>
  );
}
