// src/TelemetryDashboard.tsx
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import TelemetryAnimator from "./TelemetryAnimator";

const API_BASE = (import.meta as any)?.env?.VITE_API_BASE
  || "https://telemetry-backend-920948124720.us-west1.run.app";

const fetcher = async (url: string): Promise<any> => {
  console.log("[TelemetryDashboard] Fetching URL:", url);
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  console.log(`[TelemetryDashboard] Response status for ${url}:`, r.status);
  if (!r.ok) {
    console.error("[TelemetryDashboard] Fetch error:", r.status, await r.text());
    throw new Error(`HTTP ${r.status}`);
  }
  const json = await r.json();
  console.log("[TelemetryDashboard] Response JSON for", url, ":", json);
  return json;
};

const driverColorPalette = ["#22c55e", "#3b82f6", "#f97316"];

const SessionSchema = z.object({
  id: z.string(),
  year: z.string(),
  event: z.string(),
  session: z.string(),
});
type SessionT = z.infer<typeof SessionSchema>;

const DriverSchema = z.object({
  driverId: z.string(),
  driver_number: z.string().optional(),
  code: z.string(),
  name: z.string(),
});
type DriverT = z.infer<typeof DriverSchema>;

type TelemetryWindow = {
  t: number[];
  x?: number[];
  y?: number[];
  speed?: number[];
  throttle?: number[];
  brake?: number[];
  gear?: number[];
  drs?: number[];
  samples?: any[];
  data?: any[];
  lapMeta?: any;
  meta?: any;
  lap?: any;
  telemetry?: any;
  [key: string]: any;
};

const extractTelemetrySamples = (raw: any): any[] => {
  const telemetry = raw?.telemetry ?? raw;

  if (!telemetry || typeof telemetry !== "object") return [];

  if (Array.isArray(telemetry)) return telemetry;

  if (Array.isArray(telemetry.samples)) return telemetry.samples;

  if (Array.isArray(telemetry.data)) return telemetry.data;

  if (Array.isArray(telemetry.t)) {
    const len = telemetry.t.length;
    const samples: any[] = [];
    for (let i = 0; i < len; i++) {
      samples.push({
        t: telemetry.t[i],
        x: telemetry.x?.[i],
        y: telemetry.y?.[i],
        speed: telemetry.speed?.[i],
        throttle: telemetry.throttle?.[i],
        brake: telemetry.brake?.[i],
        gear: telemetry.gear?.[i],
        drs: telemetry.drs?.[i],
      });
    }
    return samples;
  }

  return [];
};

const LoadingOverlay = ({ message }: { message: string }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
    <div className="px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-lg shadow-lg text-sm flex items-center gap-2">
      <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
      <span>{message}</span>
    </div>
  </div>
);

async function getSessions(params: { year?: string }): Promise<SessionT[]> {
  const q = new URLSearchParams();
  if (params.year) q.set("year", params.year);
  const url = `${API_BASE}/sessions${q.toString() ? `?${q.toString()}` : ""}`;
  const raw = await fetcher(url);
  const arr: any[] = Array.isArray(raw) ? raw : (raw.sessions ?? []);
  return arr.map((s: any) => {
    return SessionSchema.parse({
      id: String(s.session_id ?? s.id),
      year: String(s.year),
      event: String(s.event),
      session: String(s.session),
    });
  });
}

async function getDriversForSession(sessionId: string): Promise<DriverT[]> {
  const url = `${API_BASE}/sessions/${sessionId}/drivers/raw`;
  const raw = await fetcher(url);
  const arr: any[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.drivers)
      ? raw.drivers
      : (raw.drivers ? Object.values(raw.drivers) : []);
  return arr.map((d: any) => {
    const driverNumber = d.driver_number ? String(d.driver_number) : undefined;
    const codeRaw = d.abbreviation;
    const nameRaw = d.driver_name;
    const driverId = d.driver_id ?? d.driverId ?? d.id ?? d.DriverId ?? driverNumber ?? codeRaw ?? "unknown";
    return DriverSchema.parse({
      driverId: String(driverId),
      driver_number: String(driverNumber),
      code: String(codeRaw),
      name: String(nameRaw),
    });
  });
}

async function fetchFastestTelemetry(
  sessionId: string,
  driverCodes: string[],
): Promise<Record<string, TelemetryWindow>> {
  if (!driverCodes.length) return {};

  const start = 0;
  const end = 999;
  const mode = "time";
  const url = `${API_BASE}/sessions/${sessionId}/fastest-telemetry?start=${start}&end=${end}&mode=${mode}`;
  const payload = { drivers: driverCodes };

  console.log(`[TelemetryDashboard] POST fastest-telemetry for drivers: ${driverCodes.join(", ")}`, url, payload);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  console.log(`[TelemetryDashboard] Response status for fastest-telemetry ${url}:`, response.status);

  if (!response.ok) {
    const bodyText = await response.text();
    console.error("[TelemetryDashboard] Fastest telemetry fetch failed:", response.status, bodyText);
    throw new Error(`HTTP ${response.status}`);
  }

  const json = await response.json();
  console.log("[TelemetryDashboard] Fastest telemetry response JSON:", json);

  const rawMap: any = json?.telemetry ?? json?.data ?? json;
  const telemetryByDriver: Record<string, TelemetryWindow> = {};

  const normalizeEntry = (key: string, entry: any) => {
    const lapMeta = entry?.lap ?? entry?.lapMeta ?? entry?.meta ?? entry?.lap_meta;
    const telemetry = entry?.telemetry ?? entry?.data ?? entry;
    const driverCode = (lapMeta?.driver ?? entry?.driver ?? key) as string;
    const window: TelemetryWindow = {
      t: Array.isArray(telemetry?.t) ? telemetry.t : [],
      ...(telemetry && typeof telemetry === "object" ? telemetry : {}),
      lapMeta: lapMeta ?? telemetry?.lapMeta ?? telemetry?.meta,
      meta: lapMeta ?? telemetry?.meta,
      lap: lapMeta,
      telemetry,
    };
    return { driverCode, window };
  };

  // First try to populate using requested driver codes
  driverCodes.forEach((code) => {
    if (rawMap && rawMap[code]) {
      const { window } = normalizeEntry(code, rawMap[code]);
      telemetryByDriver[code] = window;
    }
  });

  // Fallback: include any entries present in the response
  if (rawMap && typeof rawMap === "object") {
    Object.entries(rawMap).forEach(([key, value]) => {
      if (typeof value !== "object") return;
      const { driverCode, window } = normalizeEntry(key, value);
      const code = driverCode || key;
      if (!telemetryByDriver[code]) {
        telemetryByDriver[code] = window;
      } else if (!telemetryByDriver[code].lapMeta && window.lapMeta) {
        telemetryByDriver[code].lapMeta = window.lapMeta;
        telemetryByDriver[code].meta = window.lapMeta;
        telemetryByDriver[code].lap = window.lap;
      }
    });
  }

  return telemetryByDriver;
}

export default function TelemetryDashboard() {
  const [yearFilter, setYearFilter] = useState<string | undefined>(undefined);
  const [eventFilter, setEventFilter] = useState<string | undefined>(undefined);
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([]);
  const [drivers, setDrivers] = useState<DriverT[]>([]);
  const [telemetryData, setTelemetryData] = useState<Record<string, TelemetryWindow>>({});
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [driversLoading, setDriversLoading] = useState(false);
  const [timeCursor, setTimeCursor] = useState(0);

  const driversByNumber = useMemo(() => {
    const map: Record<string, DriverT> = {};
    drivers.forEach((d) => {
      const num = d.driver_number ?? d.driverId;
      map[num] = d;
    });
    return map;
  }, [drivers]);

  const driverColorByCode = useMemo(() => {
    const map: Record<string, string> = {};
    selectedDrivers.forEach((driverNumber, idx) => {
      const drv = driversByNumber[driverNumber];
      const driverCode = drv?.code ?? driverNumber;
      map[driverCode] = driverColorPalette[idx % driverColorPalette.length];
    });
    return map;
  }, [selectedDrivers, driversByNumber]);

  const { data: sessions, isLoading: sessionsLoading } = useSWR(
    ["sessions", yearFilter ?? ""],
    () => getSessions({ year: yearFilter }),
    { revalidateOnFocus: false }
  );

  const years = useMemo(() => {
    const y = new Date().getFullYear();
    return Array.from({ length: 6 }, (_, i) => String(y - i));
  }, []);

  const eventsForYear = useMemo(() => {
    if (!sessions) return [];
    const setEvents = new Set<string>();
    sessions.forEach((s: SessionT) => setEvents.add(s.event));
    return Array.from(setEvents).sort();
  }, [sessions]);

  const qualifyingSession = useMemo<SessionT | undefined>(() => {
    if (!sessions || !eventFilter) return undefined;
    return sessions.find((s: SessionT) => s.session === "Q" && s.event === eventFilter);
  }, [sessions, eventFilter]);

  useEffect(() => {
    if (qualifyingSession) {
      setDriversLoading(true);
      getDriversForSession(qualifyingSession.id)
        .then(setDrivers)
        .catch(err => console.error("[TelemetryDashboard] Error fetching drivers:", err))
        .finally(() => setDriversLoading(false));
      setSelectedDrivers([]);
      setTelemetryData({});
    } else {
      setDrivers([]);
      setDriversLoading(false);
    }
  }, [qualifyingSession]);


  const loadSelectedTelemetry = async () => {
    if (!qualifyingSession) return;
    if (!selectedDrivers.length) {
      setTelemetryData({});
      return;
    }

    const driverCodes = selectedDrivers
      .map((driverNumber) => driversByNumber[driverNumber]?.code ?? driverNumber)
      .filter((code): code is string => Boolean(code));
    const codesToFetch = driverCodes.filter((code) => !telemetryData[code]);

    if (!codesToFetch.length) {
      return;
    }

    setTelemetryLoading(true);
    try {
      const data = await fetchFastestTelemetry(qualifyingSession.id, codesToFetch);
      setTelemetryData((prev) => ({ ...prev, ...data }));
    } catch (err) {
      console.error(
        `[TelemetryDashboard] Error fetching fastest telemetry for drivers ${codesToFetch.join(", ")}:`,
        err
      );
    } finally {
      setTelemetryLoading(false);
    }
  };

  const lapSeries = useMemo(() => {
    return selectedDrivers
      .map((driverNumber) => {
        const drv = driversByNumber[driverNumber];
        const driverCode = drv?.code ?? driverNumber;
        const raw = telemetryData[driverCode];
        if (!raw) return null;

        const samples = extractTelemetrySamples(raw);

        const points = samples
          .map((s: any) => {
            if (s.x === undefined || s.y === undefined || s.t === undefined)
              return null;

            const wx = Number(s.x);
            const wy = Number(s.y);

            // Use raw telemetry coordinates directly for world space
            const worldX = wx;
            const worldY = wy;

            return {
              t: Number(s.t),
              x: worldX,
              y: worldY,
              speed: Number(s.speed) * (1000 / 3600),
              rawX: wx,
              rawY: wy,
            };
          })
          .filter(Boolean)
          .sort((a: any, b: any) => a.t - b.t);

        if (!points.length) return null;

        const displayName = drv?.code ?? driverCode;
        const color = driverColorByCode[driverCode] ?? driverColorPalette[0];

        return {
          driverId: driverCode,
          displayName,
          color,
          points,
        };
      })
      .filter((s): s is any => s !== null);
  }, [selectedDrivers, telemetryData, driversByNumber]);

  // Debug helper: get current (x, y) for first lap series at current time cursor
  // const debugPosition = useMemo(() => {
  //   if (!lapSeries.length) return null;
  //   const s = lapSeries[0];
  //   if (!s.points || !s.points.length) return null;

  //   let best: any = s.points[0];
  //   let bestDt = Math.abs(best.t - timeCursor);
  //   for (let i = 1; i < s.points.length; i++) {
  //     const p: any = s.points[i];
  //     const dt = Math.abs(p.t - timeCursor);
  //     if (dt < bestDt) {
  //       best = p;
  //       bestDt = dt;
  //     }
  //   }
  //   return {
  //     driverId: s.driverId,
  //     displayName: s.displayName,
  //     t: best.t,
  //     x: best.rawX ?? best.x,
  //     y: best.rawY ?? best.y,
  //   };
  // }, [lapSeries, timeCursor]);

  const renderMetricChart = (
    metric: "speed" | "throttle" | "brake" | "gear",
    label: string
  ) => {
    if (!selectedDrivers.length) return null;

    const seriesByDriver = selectedDrivers
      .map((driverNumber) => {
        const drv = driversByNumber[driverNumber];
        const driverCode = drv?.code ?? driverNumber;
        const raw = telemetryData[driverCode];
        if (!raw) return null;

        const samples = extractTelemetrySamples(raw);

        const points = samples
          .map((s: any) => {
            if (s.t === undefined || s[metric] === undefined) return null;
            let v = Number(s[metric]);
            // Brake is a binary signal (on/off)
            if (metric === "brake") {
              v = v > 0.5 ? 1 : 0;
            }
            return {
              t: Number(s.t),
              v,
            };
          })
          .filter((p: any) => p !== null)
          .sort((a: any, b: any) => a.t - b.t);

        if (!points.length) return null;

        const displayName = drv?.code ?? driverCode;
        const color = driverColorByCode[driverCode] ?? driverColorPalette[0];

        return { driverCode, displayName, color, points };
      })
      .filter((s): s is { driverCode: string; displayName: string; color: string; points: { t: number; v: number }[] } => s !== null);

    if (!seriesByDriver.length) return null;

    let tMin = Infinity;
    let tMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;

    seriesByDriver.forEach((s) => {
      s.points.forEach((p) => {
        if (p.t < tMin) tMin = p.t;
        if (p.t > tMax) tMax = p.t;
        if (p.v < vMin) vMin = p.v;
        if (p.v > vMax) vMax = p.v;
      });
    });

    if (!isFinite(tMin) || !isFinite(tMax) || tMax <= tMin) {
      return null;
    }

    if (!isFinite(vMin) || !isFinite(vMax) || vMax <= vMin) {
      // fallback to a small range around the single value
      const mid = isFinite(vMin) ? vMin : 0;
      vMin = mid - 1;
      vMax = mid + 1;
    }
    // For throttle, use a fixed 0–100% range; for brake, use 0–1 (binary on/off)
    if (metric === "throttle") {
      vMin = 0;
      vMax = 100;
    } else if (metric === "brake") {
      vMin = 0;
      vMax = 1;
    }

    const viewWidth = 100;
    const viewHeight = 100;

    const clampTime = (t: number) =>
      Math.max(tMin, Math.min(tMax, t));

    const cursorT = clampTime(timeCursor);

    const formatMetricValue = (
      metric: "speed" | "throttle" | "brake" | "gear",
      v: number
    ): string => {
      if (!isFinite(v)) return "—";
      switch (metric) {
        case "speed":
          // assume km/h from raw telemetry
          return `${v.toFixed(1)} km/h`;
        case "throttle":
          return `${v.toFixed(0)}%`;
        case "brake":
          // Binary on/off display
          return v >= 0.5 ? "ON" : "OFF";
        case "gear":
          return `${v.toFixed(0)}`;
        default:
          return v.toFixed(2);
      }
    };

    const metricValueStrings: string[] = [];
    seriesByDriver.forEach((s) => {
      if (!s.points.length) return;
      let best = s.points[0];
      let bestDt = Math.abs(best.t - cursorT);
      for (let i = 1; i < s.points.length; i++) {
        const p = s.points[i];
        const dt = Math.abs(p.t - cursorT);
        if (dt < bestDt) {
          best = p;
          bestDt = dt;
        }
      }
      metricValueStrings.push(
        `${s.displayName}: ${formatMetricValue(metric, best.v)}`
      );
    });

    // Define a local time window around the cursor (e.g., 5 seconds total)
    const windowSeconds = 5;
    let windowStart = cursorT - windowSeconds / 2;
    let windowEnd = cursorT + windowSeconds / 2;

    // Clamp window to global [tMin, tMax]
    if (windowStart < tMin) {
      const diff = tMin - windowStart;
      windowStart = tMin;
      windowEnd = Math.min(tMax, windowEnd + diff);
    }
    if (windowEnd > tMax) {
      const diff = windowEnd - tMax;
      windowEnd = tMax;
      windowStart = Math.max(tMin, windowStart - diff);
    }

    // Fallback in degenerate case
    if (windowEnd - windowStart < 0.5) {
      windowStart = Math.max(tMin, cursorT - 0.25);
      windowEnd = Math.min(tMax, cursorT + 0.25);
    }

    const windowSpan = windowEnd - windowStart || 1;

    const cursorX = ((cursorT - windowStart) / windowSpan) * viewWidth;

    const buildPath = (points: { t: number; v: number }[]) => {
      // Only include points within the current time window
      const visible = points.filter(
        (p) => p.t >= windowStart && p.t <= windowEnd
      );
      if (!visible.length) return "";
      return visible
        .map((p, idx) => {
          const x = ((p.t - windowStart) / windowSpan) * viewWidth;
          const yNorm = (p.v - vMin) / (vMax - vMin);
          const y = viewHeight - yNorm * viewHeight;
          const cmd = idx === 0 ? "M" : "L";
          return `${cmd}${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
    };

    return (
      <div className="w-full" key={metric}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-gray-400 truncate">
            {metricValueStrings.join("  |  ")}
          </span>
        </div>
        <svg
          viewBox={`0 0 ${viewWidth} ${viewHeight}`}
          className="w-full h-32 bg-neutral-900 rounded-md border border-neutral-800"
          preserveAspectRatio="none"
        >
          {/* vertical cursor */}
          <line
            x1={cursorX}
            y1={0}
            x2={cursorX}
            y2={viewHeight}
            stroke="#9ca3af"
            strokeWidth={0.4}
            strokeDasharray="1.5,2"
          />
          {seriesByDriver.map((s) => (
            <path
              key={s.driverCode + metric}
              d={buildPath(s.points)}
              fill="none"
              stroke={s.color}
              strokeWidth={metric === "throttle" || metric === "brake" ? 1.2 : 0.8}
            />
          ))}
        </svg>
        <div className="flex flex-wrap gap-2 mt-1">
          {seriesByDriver.map((s) => (
            <div key={s.driverCode} className="flex items-center gap-1 text-xs text-gray-300">
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              <span>{s.displayName}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

return (
    <div className="max-w-4xl mx-auto p-4 bg-neutral-950 text-neutral-100 min-h-screen">
      <h1 className="text-2xl font-semibold mb-4">
        Telemetry Dashboard — Compare Qualifying Laps
      </h1>

      {/* Filters: Year & Event */}
      <div className="flex gap-4 mb-6">
        <Select
          value={yearFilter ?? "all"}
          onValueChange={(v: string) => {
            const newYear = v === "all" ? undefined : v;
            setYearFilter(newYear);
            setEventFilter(undefined);
          }}
        >
          <SelectTrigger className="w-[120px] bg-neutral-800 text-neutral-100 border border-neutral-700"><SelectValue placeholder="Year" /></SelectTrigger>
          <SelectContent className="bg-neutral-800 text-neutral-100 border border-neutral-700">
            <SelectItem value="all">All Years</SelectItem>
            {years.map(y => <SelectItem key={y} value={y}>{y}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select
          value={eventFilter ?? "all"}
          onValueChange={(v: string) => {
            const newEvent = v === "all" ? undefined : v;
            setEventFilter(newEvent);
          }}
          disabled={!yearFilter}
        >
          <SelectTrigger className="w-[200px] bg-neutral-800 text-neutral-100 border border-neutral-700"><SelectValue placeholder="Event" /></SelectTrigger>
          <SelectContent className="bg-neutral-800 text-neutral-100 border border-neutral-700">
            <SelectItem value="all">All Events</SelectItem>
            {eventsForYear.map(ev => <SelectItem key={ev} value={ev}>{ev}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {qualifyingSession && (
        <div className="flex flex-col gap-2 mb-6">
          <label className="font-medium">Select up to 3 drivers:</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {drivers.map((d: DriverT) => {
              const num = d.driver_number ?? d.driverId;
              const displayName = d.name;
              const isChecked = selectedDrivers.includes(num);
              return (
                <label key={num} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    value={num}
                    checked={isChecked}
                    onChange={(e) => {
                      const val = e.target.value;
                      let newSelected = isChecked
                        ? selectedDrivers.filter((x) => x !== val)
                        : [...selectedDrivers, val];
                      if (newSelected.length > 3) {
                        newSelected = newSelected.slice(0, 3);
                      }
                      setSelectedDrivers(newSelected);
                    }}
                  />
                  <span>{displayName} (#{num})</span>
                </label>
              );
            })}
          </div>
          {selectedDrivers.length >= 3 && (
            <div className="text-sm text-red-600">
              You have selected {selectedDrivers.length} drivers — the limit is 3.
            </div>
          )}
        </div>
      )}

      {selectedDrivers.length > 0 && (
        <div className="mt-2">
          <span className="font-medium">Selected drivers:</span>
          <ul className="list-none p-0 flex flex-col gap-2 mt-1">
            {selectedDrivers.map((driverNumber) => {
              const drv = driversByNumber[driverNumber];
              const name = drv?.name ?? driverNumber;
              const driverCode = drv?.code ?? driverNumber;
              const raw = telemetryData[driverCode];
              const meta = raw?.lapMeta ?? raw?.meta ?? raw?.lap ?? raw?.lap_meta ?? undefined;

              const lapTimeSec = meta
                ? Number(
                  meta.lap_time_s
                )
                : undefined;

              const s1Sec = meta
                ? Number(
                  meta.sector1_s
                )
                : undefined;

              const s2Sec = meta
                ? Number(
                  meta.sector2_s
                )
                : undefined;

              const s3Sec = meta
                ? Number(
                  meta.sector3_s
                )
                : undefined;

              const formatTime = (seconds?: number): string => {
                if (seconds === undefined || !isFinite(seconds)) return "—";
                const totalMs = Math.round(seconds * 1000);
                const minutes = Math.floor(totalMs / 60000);
                const sec = Math.floor((totalMs % 60000) / 1000);
                const ms = totalMs % 1000;
                const secStr = sec.toString().padStart(2, "0");
                const msStr = ms.toString().padStart(3, "0");
                return `${minutes}:${secStr}.${msStr}`;
              };

              return (
                <li
                  key={driverNumber}
                  className="px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-md text-sm flex flex-col"
                >
                  <div className="font-medium">
                    {name} (#{driverNumber})
                  </div>
                  <div className="text-xs text-neutral-400 mt-1">
                    <div>
                      Lap:{" "}
                      <span className="font-mono">
                        {formatTime(lapTimeSec)}
                      </span>
                    </div>
                    <div className="flex gap-4 mt-0.5">
                      <div>
                        S1:{" "}
                        <span className="font-mono">
                          {formatTime(s1Sec)}
                        </span>
                      </div>
                      <div>
                        S2:{" "}
                        <span className="font-mono">
                          {formatTime(s2Sec)}
                        </span>
                      </div>
                      <div>
                        S3:{" "}
                        <span className="font-mono">
                          {formatTime(s3Sec)}
                        </span>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={loadSelectedTelemetry}
              className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              disabled={telemetryLoading}
            >
              {telemetryLoading ? "Loading telemetry…" : "Load telemetry for selected drivers"}
            </button>
            <span className="text-xs text-neutral-400">
              Loaded:&nbsp;
              {selectedDrivers
                .map((driverNumber) => {
                  const drv = driversByNumber[driverNumber];
                  const code = drv?.code ?? driverNumber;
                  return telemetryData[code] ? code : null;
                })
                .filter(Boolean)
                .join(", ") || "none"}
            </span>
            {telemetryLoading && (
              <span className="text-xs text-blue-400" aria-live="polite">
                Fetching telemetry…
              </span>
            )}
          </div>
        </div>
      )}

      {selectedDrivers.length > 0 && lapSeries.length > 0 && (
        <div className="mt-6">
          <h2 className="text-xl font-medium mb-2">Lap Animation</h2>
          <TelemetryAnimator
            series={lapSeries}
            showTrailMeters={150}
            playbackRate={1}
            onTimeCursorChange={(t: number) => setTimeCursor(t)}
          />
        </div>
      )}

      {selectedDrivers.length > 0 && (
        <div className="mt-6 space-y-4">
          <h2 className="text-xl font-medium mb-1">Telemetry Charts</h2>
          {renderMetricChart("speed", "Speed")}
          {renderMetricChart("throttle", "Throttle")}
          {renderMetricChart("brake", "Brake")}
          {renderMetricChart("gear", "Gear")}
        </div>
      )}

      {sessionsLoading && <div className="text-center p-4 text-gray-500">Loading sessions…</div>}

      {!sessionsLoading && !qualifyingSession && yearFilter && eventFilter && (
        <div className="text-center text-gray-500 p-4">
          No qualifying session found for the selected event.
        </div>
      )}

      {(sessionsLoading || driversLoading) && (
        <LoadingOverlay message={driversLoading ? "Loading session results…" : "Loading sessions…"} />
      )}
    </div>
  );
}
