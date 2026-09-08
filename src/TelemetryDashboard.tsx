// src/TelemetryDashboard.tsx
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import TelemetryAnimator from "./TelemetryAnimator";

const API_BASE = (import.meta.env.VITE_API_BASE
  || "https://telemetry-backend-920948124720.us-west1.run.app").replace(/\/$/, "");
const DEFAULT_YEAR = String(new Date().getFullYear());

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const fetchJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  const r = await fetch(url, {
    ...init,
    headers: { "Accept": "application/json", ...init?.headers },
  });
  if (!r.ok) {
    let message = `Request failed with HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (typeof body?.detail === "string") message = body.detail;
    } catch {
      // Keep the status-based fallback for non-JSON errors.
    }
    throw new ApiError(r.status, message);
  }
  return r.json();
};

const driverColorPalette = ["#22c55e", "#3b82f6", "#f97316"];

const SessionSchema = z.object({
  session_id: z.string(),
  year: z.number(),
  event: z.string(),
  session: z.string(),
});
type SessionT = {
  id: string;
  year: number;
  event: string;
  session: string;
};

const DriverSchema = z.object({
  driver_number: z.number().nullable(),
  driver_name: z.string().nullable(),
  abbreviation: z.string().nullable(),
  position: z.number().nullable(),
});
type DriverT = {
  driverNumber?: string;
  code: string;
  name: string;
};

const TelemetryWindowSchema = z.object({
  mode: z.enum(["time", "distance"]),
  hz: z.number(),
  t: z.array(z.number()).nullable(),
  d: z.array(z.number()).nullable(),
  x: z.array(z.number()),
  y: z.array(z.number()),
  speed: z.array(z.number()),
  throttle: z.array(z.number()),
  brake: z.array(z.number()),
  gear: z.array(z.number()),
  drs: z.array(z.number()),
});
type TelemetryWindow = z.infer<typeof TelemetryWindowSchema>;
type LapPoint = {
  t: number;
  x: number;
  y: number;
  speed: number;
};
type LapSeries = {
  driverId: string;
  displayName: string;
  color: string;
  points: LapPoint[];
};

const extractTelemetrySamples = (telemetry: TelemetryWindow) => {
  if (telemetry.mode !== "time" || !telemetry.t) return [];
  return telemetry.t.map((t, index) => ({
    t,
    x: telemetry.x[index],
    y: telemetry.y[index],
    speed: telemetry.speed[index],
    throttle: telemetry.throttle[index],
    brake: telemetry.brake[index],
    gear: telemetry.gear[index],
    drs: telemetry.drs[index],
  }));
};

const LoadingOverlay = ({ message }: { message: string }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
    <div className="px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-lg shadow-lg text-sm flex items-center gap-2">
      <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
      <span>{message}</span>
    </div>
  </div>
);

async function getSessions(year: string): Promise<SessionT[]> {
  const raw = z.array(SessionSchema).parse(
    await fetchJson(`${API_BASE}/sessions?year=${encodeURIComponent(year)}`)
  );
  return raw.map((session) => ({
    id: session.session_id,
    year: session.year,
    event: session.event,
    session: session.session,
  }));
}

async function getDriversForSession(sessionId: string): Promise<DriverT[]> {
  const raw = z.array(DriverSchema).parse(
    await fetchJson(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/drivers/raw`)
  );

  // A code is required by fastest-telemetry, so rows without one cannot be selected.
  return raw.flatMap((driver) => {
    const code = driver.abbreviation?.trim().toUpperCase();
    if (!code) return [];
    return [{
      driverNumber: driver.driver_number == null ? undefined : String(driver.driver_number),
      code,
      name: driver.driver_name?.trim() || code,
    }];
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
  const url = `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/fastest-telemetry?start=${start}&end=${end}&mode=${mode}`;
  const payload = { drivers: driverCodes };

  const raw = await fetchJson(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const rawMap = z.record(z.string(), TelemetryWindowSchema).parse(raw);
  const telemetryByDriver: Record<string, TelemetryWindow> = {};

  // Results are keyed by lap_id, not by driver. Match only against requested
  // codes because canonical event names can contain spaces and underscores.
  Object.entries(rawMap).forEach(([lapId, telemetry]) => {
    const codeFromLapId = lapId.match(/_([^_]+)_[^_]+$/)?.[1]?.toUpperCase();
    const driverCode = driverCodes.find((code) => code.toUpperCase() === codeFromLapId);
    if (driverCode) telemetryByDriver[driverCode] = telemetry;
  });

  return telemetryByDriver;
}

export default function TelemetryDashboard() {
  const [yearFilter, setYearFilter] = useState(DEFAULT_YEAR);
  const [eventFilter, setEventFilter] = useState<string | undefined>(undefined);
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([]);
  const [drivers, setDrivers] = useState<DriverT[]>([]);
  const [telemetryData, setTelemetryData] = useState<Record<string, TelemetryWindow>>({});
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [driversLoading, setDriversLoading] = useState(false);
  const [driversError, setDriversError] = useState<string>();
  const [telemetryError, setTelemetryError] = useState<string>();
  const [timeCursor, setTimeCursor] = useState(0);
  const [layoutMode, setLayoutMode] = useState<'stacked' | 'side-by-side'>('stacked');

  const driversByCode = useMemo(() => {
    const map: Record<string, DriverT> = {};
    drivers.forEach((d) => {
      map[d.code] = d;
    });
    return map;
  }, [drivers]);

  const driverColorByCode = useMemo(() => {
    const map: Record<string, string> = {};
    selectedDrivers.forEach((driverCode, idx) => {
      map[driverCode] = driverColorPalette[idx % driverColorPalette.length];
    });
    return map;
  }, [selectedDrivers]);

  const { data: sessions, error: sessionsError, isLoading: sessionsLoading } = useSWR(
    ["sessions", yearFilter],
    () => getSessions(yearFilter),
    {
      dedupingInterval: 30_000,
      refreshInterval: 5 * 60_000,
      revalidateOnFocus: true,
      shouldRetryOnError: (error) => error instanceof ApiError && error.status === 503,
    }
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
      let cancelled = false;
      setDriversLoading(true);
      setDriversError(undefined);
      setDrivers([]);
      getDriversForSession(qualifyingSession.id)
        .then((nextDrivers) => {
          if (!cancelled) setDrivers(nextDrivers);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setDrivers([]);
          setDriversError(error instanceof Error ? error.message : "Unable to load drivers.");
        })
        .finally(() => {
          if (!cancelled) setDriversLoading(false);
        });
      setSelectedDrivers([]);
      setTelemetryData({});
      setTelemetryError(undefined);
      return () => {
        cancelled = true;
      };
    } else {
      setDrivers([]);
      setDriversLoading(false);
      setDriversError(undefined);
    }
  }, [qualifyingSession]);


  const loadSelectedTelemetry = async () => {
    if (!qualifyingSession) return;
    if (!selectedDrivers.length) {
      setTelemetryData({});
      return;
    }

    const codesToFetch = selectedDrivers.filter((code) => !telemetryData[code]);

    if (!codesToFetch.length) {
      return;
    }

    setTelemetryLoading(true);
    setTelemetryError(undefined);
    try {
      const data = await fetchFastestTelemetry(qualifyingSession.id, codesToFetch);
      setTelemetryData((prev) => ({ ...prev, ...data }));
      const missing = codesToFetch.filter((code) => !data[code]);
      if (missing.length) {
        setTelemetryError(`No usable fastest lap was returned for ${missing.join(", ")}.`);
      }
    } catch (err) {
      setTelemetryError(err instanceof Error ? err.message : "Unable to load telemetry.");
    } finally {
      setTelemetryLoading(false);
    }
  };

  const lapSeries = useMemo<LapSeries[]>(() => {
    return selectedDrivers
      .map((driverCode) => {
        const drv = driversByCode[driverCode];
        const raw = telemetryData[driverCode];
        if (!raw) return null;

        const samples = extractTelemetrySamples(raw);

        const points = samples
          .flatMap((sample): LapPoint[] => {
            if (sample.x === undefined || sample.y === undefined) return [];

            const wx = Number(sample.x);
            const wy = Number(sample.y);

            // Use raw telemetry coordinates directly for world space
            const worldX = wx;
            const worldY = wy;

            return [{
              t: sample.t,
              x: worldX,
              y: worldY,
              speed: Number(sample.speed) * (1000 / 3600),
            }];
          })
          .sort((a, b) => a.t - b.t);

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
      .filter((series): series is LapSeries => series !== null);
  }, [selectedDrivers, telemetryData, driversByCode, driverColorByCode]);

  const renderMetricChart = (
    metric: "speed" | "throttle" | "brake" | "gear",
    label: string
  ) => {
    if (!selectedDrivers.length) return null;

    const seriesByDriver = selectedDrivers
      .map((driverCode) => {
        const drv = driversByCode[driverCode];
        const raw = telemetryData[driverCode];
        if (!raw) return null;

        const samples = extractTelemetrySamples(raw);

        const points = samples
          .flatMap((sample): { t: number; v: number }[] => {
            if (sample[metric] === undefined) return [];
            let v = Number(sample[metric]);
            // Brake is a binary signal (on/off)
            if (metric === "brake") {
              v = v > 0.5 ? 1 : 0;
            }
            return [{
              t: sample.t,
              v,
            }];
          })
          .sort((a, b) => a.t - b.t);

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
          <span className="text-xs text-gray-400 truncate min-w-0 text-right flex-shrink-0" style={{ minWidth: '300px' }}>
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
    <div className={`${layoutMode === 'side-by-side' ? 'max-w-6xl' : 'max-w-4xl'} mx-auto p-4 bg-neutral-950 text-neutral-100 min-h-screen`}>
      <h1 className="text-2xl font-semibold mb-4">
        Telemetry Dashboard — Compare Qualifying Laps
      </h1>

      {/* Filters: Year & Event */}
      <div className="flex gap-4 mb-6">
        <Select
          value={yearFilter}
          onValueChange={(v: string) => {
            setYearFilter(v);
            setEventFilter(undefined);
          }}
        >
          <SelectTrigger className="w-[120px] bg-neutral-800 text-neutral-100 border border-neutral-700"><SelectValue placeholder="Year" /></SelectTrigger>
          <SelectContent className="bg-neutral-800 text-neutral-100 border border-neutral-700">
            {years.map(y => <SelectItem key={y} value={y}>{y}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select
          value={eventFilter ?? "all"}
          onValueChange={(v: string) => {
            const newEvent = v === "all" ? undefined : v;
            setEventFilter(newEvent);
          }}
          disabled={sessionsLoading || Boolean(sessionsError)}
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
              const code = d.code;
              const displayName = d.name;
              const isChecked = selectedDrivers.includes(code);
              return (
                <label key={code} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    value={code}
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
                  <span>
                    {displayName} ({code}{d.driverNumber ? `, #${d.driverNumber}` : ""})
                  </span>
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
            {selectedDrivers.map((driverCode) => {
              const drv = driversByCode[driverCode];
              const name = drv?.name ?? driverCode;
              const loaded = Boolean(telemetryData[driverCode]);

              return (
                <li
                  key={driverCode}
                  className="px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-md text-sm flex items-center justify-between"
                >
                  <div className="font-medium">
                    {name} ({driverCode}{drv?.driverNumber ? `, #${drv.driverNumber}` : ""})
                  </div>
                  <span className={loaded ? "text-xs text-green-400" : "text-xs text-neutral-500"}>
                    {loaded ? "Telemetry loaded" : "Not loaded"}
                  </span>
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
                .map((code) => telemetryData[code] ? code : null)
                .filter(Boolean)
                .join(", ") || "none"}
            </span>
            {telemetryLoading && (
              <span className="text-xs text-blue-400" aria-live="polite">
                Fetching telemetry…
              </span>
            )}
          </div>
          {telemetryError && (
            <p className="mt-2 text-sm text-red-400" role="alert">{telemetryError}</p>
          )}
        </div>
      )}

      {selectedDrivers.length > 0 && lapSeries.length > 0 && (
        <>
          {/* Layout toggle button */}
          <div className="mt-6 flex items-center justify-between mb-3">
            <h2 className="text-xl font-medium">Telemetry View</h2>
            <button
              onClick={() => setLayoutMode(prev => prev === 'stacked' ? 'side-by-side' : 'stacked')}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm transition-colors"
            >
              {layoutMode === 'stacked' ? 'Side-by-side view' : 'Stacked view'}
            </button>
          </div>

          {/* Main layout container */}
          <div className={layoutMode === 'side-by-side'
            ? 'flex flex-col lg:flex-row gap-6'
            : 'flex flex-col'}>

            {/* Lap Animation section */}
            <div className={layoutMode === 'side-by-side' ? 'w-[40%]' : 'w-full'}>
              <h3 className="text-lg font-medium mb-2">Lap Animation</h3>
              <TelemetryAnimator
                series={lapSeries}
                showTrailMeters={150}
                playbackRate={1}
                height={layoutMode === 'side-by-side' ? 680 : 520}
                onTimeCursorChange={(t: number) => setTimeCursor(t)}
              />
            </div>

            {/* Telemetry Charts section */}
            {selectedDrivers.length > 0 && (
              <div className={layoutMode === 'side-by-side' ? 'w-[60%] space-y-4' : 'mt-6 space-y-4'}>
                <h3 className="text-lg font-medium mb-1">Telemetry Charts</h3>
                {renderMetricChart("speed", "Speed")}
                {renderMetricChart("throttle", "Throttle")}
                {renderMetricChart("brake", "Brake")}
                {renderMetricChart("gear", "Gear")}
              </div>
            )}
          </div>
        </>
      )}

      {sessionsLoading && <div className="text-center p-4 text-gray-500">Loading sessions…</div>}

      {sessionsError && (
        <div className="text-center p-4 text-red-400" role="alert">
          {sessionsError instanceof Error ? sessionsError.message : "Unable to load sessions."}
        </div>
      )}

      {driversError && (
        <div className="text-center p-4 text-red-400" role="alert">{driversError}</div>
      )}

      {!sessionsLoading && !sessionsError && sessions?.length === 0 && (
        <div className="text-center p-4 text-gray-500">
          No processed qualifying sessions are available for {yearFilter}.
        </div>
      )}

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
