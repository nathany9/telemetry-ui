import React, { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Brush } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Gauge, Activity, MapPin, ListFilter, PlayCircle, PauseCircle, UploadCloud, Settings } from "lucide-react";

/**
 * Telemetry Dashboard – Frontend Starter (React + Tailwind + shadcn/ui + Recharts)
 * ------------------------------------------------------------------------------
 * Drop this file into your React app (e.g., Vite/Next) and render <TelemetryDashboard />.
 * 
 * ✅ Production-minded defaults:
 *    - Strong typing + runtime validation with Zod
 *    - Centralized API base + fetcher + light caching via SWR
 *    - Pluggable adapters to map your backend schema to the UI types
 *    - Metric picker, smoothing, and brush zoom for timeseries
 *    - Session filter bar + table, lap picker, and quick stats
 * 
 * 🔧 Wire your endpoints in the API section below. Minimal changes needed.
 */

// -------------------------------
// API & Types
// -------------------------------
const API_BASE = (import.meta as any)?.env?.VITE_API_BASE || (window as any)?.API_BASE || "http://127.0.0.1:8000";
const fetcher = (url: string) => fetch(url, { headers: { "Accept": "application/json" } }).then(r => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});

// --- Expected UI types (stable) ---
const Session = z.object({
  id: z.string().or(z.number()).transform(String),
  date: z.string(), // ISO date/time
  track: z.string().optional().default("Unknown Track"),
  driver: z.string().optional().default("Unknown Driver"),
  car: z.string().optional().default("Unknown Car"),
  laps: z.number().optional().default(0),
});
export type SessionT = z.infer<typeof Session>;

const Lap = z.object({
  lap: z.number(),
  time_ms: z.number().optional().default(0), // lap time
});
export type LapT = z.infer<typeof Lap>;

// A single telemetry sample point – timestamps can be ms or s; normalize in adapter
const TelemetryPoint = z.object({
  t: z.number(), // seconds from lap start
  speed: z.number().optional(),
  rpm: z.number().optional(),
  throttle: z.number().optional(),
  brake: z.number().optional(),
  gear: z.number().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});
export type TelemetryPointT = z.infer<typeof TelemetryPoint>;

// -------------------------------
// Backend Adapters (EDIT THESE)
// -------------------------------
// If your FastAPI returns a different shape, adapt it here and keep the UI stable.

async function getSessions(params: { year?: string; driver?: string; car?: string }) {
  const q = new URLSearchParams();
  if (params.year) q.set("year", params.year);
  if (params.driver) q.set("driver", params.driver);
  if (params.car) q.set("car", params.car);
  // Example: GET /sessions?year=2024
  const raw = await fetcher(`${API_BASE}/sessions${q.toString() ? `?${q.toString()}` : ""}`);
  // Flexible mapping: accept either {sessions:[...] } or [...]
  const arr = Array.isArray(raw) ? raw : raw.sessions ?? [];
  const sessions = arr.map((s: any) => Session.parse({
    id: s.id ?? s.session_id ?? String(s.uuid ?? s._id),
    date: s.date ?? s.started_at ?? s.created_at ?? new Date().toISOString(),
    track: s.track ?? s.track_name ?? "Unknown Track",
    driver: s.driver ?? s.driver_name ?? "Unknown Driver",
    car: s.car ?? s.vehicle ?? s.chassis ?? "Unknown Car",
    laps: s.laps ?? s.num_laps ?? 0,
  })) as SessionT[];
  return sessions;
}

async function getLaps(sessionId: string) {
  // Example: GET /sessions/{id}/laps
  const raw = await fetcher(`${API_BASE}/sessions/${sessionId}/laps`);
  const arr = Array.isArray(raw) ? raw : raw.laps ?? [];
  return arr.map((l: any) => Lap.parse({ lap: l.lap ?? l.lap_number ?? l.index, time_ms: l.time_ms ?? l.time ?? l.lap_time_ms ?? 0 })) as LapT[];
}

async function getTelemetry(sessionId: string, lap: number) {
  // Example: GET /sessions/{id}/telemetry?lap={lap}
  const raw = await fetcher(`${API_BASE}/sessions/${sessionId}/telemetry?lap=${lap}`);
  const arr = Array.isArray(raw) ? raw : raw.samples ?? raw.points ?? [];
  // Normalize timestamps to seconds
  return arr.map((p: any) => TelemetryPoint.parse({
    t: typeof p.t === "number" ? (p.t > 1e4 ? p.t / 1000 : p.t) : (p.time_s ?? (p.time_ms ? p.time_ms / 1000 : 0)),
    speed: num(p.speed ?? p.v ?? p.speed_kph),
    rpm: num(p.rpm),
    throttle: num(p.throttle ?? p.throttle_pct),
    brake: num(p.brake ?? p.brake_pct),
    gear: num(p.gear),
    lat: num(p.lat ?? p.latitude),
    lon: num(p.lon ?? p.longitude),
  })) as TelemetryPointT[];
}

function num(x: any): number | undefined {
  if (x === null || x === undefined) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

// -------------------------------
// UI – Filters & Controls
// -------------------------------
function SessionFilters({ value, onChange }: { value: FilterState; onChange: (v: FilterState) => void }) {
  const years = useMemo(() => {
    const y = new Date().getFullYear();
    return Array.from({ length: 6 }, (_, i) => String(y - i));
  }, []);

  const yearValue = value.year ?? "all";


  return (
    <div className="flex flex-wrap items-center gap-3 p-3 bg-white/70 dark:bg-neutral-900/70 rounded-2xl shadow-sm border">
      <div className="flex items-center gap-2"><ListFilter className="w-4 h-4" />
        <span className="font-medium">Filters</span>
      </div>

        <Select
        value={yearValue}
        onValueChange={(v) => onChange({ ...value, year: v === "all" ? undefined : v })}
        >
        <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Year" />
        </SelectTrigger>
        <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {years.map(y => <SelectItem key={y} value={y}>{y}</SelectItem>)}
        </SelectContent>
        </Select>

      <Input placeholder="Driver" className="w-[160px]" value={value.driver ?? ""} onChange={(e) => onChange({ ...value, driver: e.target.value || undefined })} />
      <Input placeholder="Car" className="w-[160px]" value={value.car ?? ""} onChange={(e) => onChange({ ...value, car: e.target.value || undefined })} />

      <Button variant="secondary" size="sm" onClick={() => onChange({})}><RefreshCw className="w-4 h-4 mr-1"/>Reset</Button>
    </div>
  );
}

// -------------------------------
// UI – Session Table
// -------------------------------
function SessionTable({ sessions, selectedId, onSelect }: { sessions: SessionT[]; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-white dark:bg-neutral-900">
      <table className="min-w-full text-sm">
        <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300">
          <tr>
            <th className="text-left p-3">Date</th>
            <th className="text-left p-3">Track</th>
            <th className="text-left p-3">Driver</th>
            <th className="text-left p-3">Car</th>
            <th className="text-right p-3">Laps</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map(s => (
            <tr key={s.id} className={`cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800 ${selectedId===s.id?"bg-neutral-50 dark:bg-neutral-800":""}`} onClick={() => onSelect(s.id)}>
              <td className="p-3">{fmtDate(s.date)}</td>
              <td className="p-3">{s.track}</td>
              <td className="p-3">{s.driver}</td>
              <td className="p-3">{s.car}</td>
              <td className="p-3 text-right">{s.laps}</td>
            </tr>
          ))}
          {sessions.length === 0 && (
            <tr><td className="p-4 text-neutral-500" colSpan={5}>No sessions match your filters.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso }
}

// -------------------------------
// UI – Lap Picker & Stats
// -------------------------------
function LapPicker({ laps, value, onChange }: { laps: LapT[]; value?: number; onChange: (lap: number) => void }) {
  const best = useMemo(() => laps.reduce((acc, l) => !acc || (l.time_ms ?? 9e12) < (acc.time_ms ?? 9e12) ? l : acc, undefined as LapT | undefined), [laps]);
  return (
    <div className="flex items-center gap-3">
      <Select value={value?.toString()} onValueChange={(v)=>onChange(Number(v))}>
        <SelectTrigger className="w-[160px]"><SelectValue placeholder="Select lap"/></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Laps</SelectLabel>
            {laps.map(l => <SelectItem key={l.lap} value={String(l.lap)}>Lap {l.lap} {l.time_ms?`– ${ms(l.time_ms)}`:""}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
      {best && <Badge variant="outline">Best: Lap {best.lap} • {ms(best.time_ms||0)}</Badge>}
    </div>
  );
}

function ms(x: number) {
  const s = x/1000; const m = Math.floor(s/60); const r = (s%60).toFixed(3);
  return `${m}:${Number(r) < 10 ? "0" : ""}${r}`;
}

// -------------------------------
// UI – Timeseries Telemetry Chart
// -------------------------------
const METRICS = [
  { key: "speed" as const, label: "Speed" },
  { key: "rpm" as const, label: "RPM" },
  { key: "throttle" as const, label: "Throttle" },
  { key: "brake" as const, label: "Brake" },
  { key: "gear" as const, label: "Gear" },
];

type MetricKey = typeof METRICS[number]["key"];

function smooth(points: TelemetryPointT[], k: number, key: MetricKey) {
  if (k <= 1) return points;
  const half = Math.floor(k/2);
  const out = points.map((p, i) => {
    let sum = 0, count = 0;
    for (let j = i-half; j <= i+half; j++) {
      if (j>=0 && j<points.length) {
        const v = (points[j] as any)[key];
        if (typeof v === "number") { sum += v; count++; }
      }
    }
    return { ...p, [key]: count? sum / count : (p as any)[key] } as TelemetryPointT;
  });
  return out;
}

function TelemetryChart({ data, metric, smoothing }: { data: TelemetryPointT[]; metric: MetricKey; smoothing: number }) {
  const series = useMemo(() => smooth(data, smoothing, metric).map(p => ({ t: p.t, v: (p as any)[metric] })), [data, metric, smoothing]);
  return (
    <div className="h-[320px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ left: 12, right: 12, top: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="t" tickFormatter={(v)=>`${v.toFixed(1)}s`} />
          <YAxis />
          <Tooltip formatter={(v:any)=>typeof v==='number'? v.toFixed(2):v} labelFormatter={(l)=>`${Number(l).toFixed(2)}s`} />
          <Line type="monotone" dataKey="v" dot={false} strokeWidth={2} />
          <Brush dataKey="t" height={18} travellerWidth={8} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// -------------------------------
// Root Component
// -------------------------------

type FilterState = { year?: string; driver?: string; car?: string };

export default function TelemetryDashboard() {
  const [filters, setFilters] = useState<FilterState>({});
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [selectedLap, setSelectedLap] = useState<number | undefined>(undefined);
  const [metric, setMetric] = useState<MetricKey>("speed");
  const [smoothing, setSmoothing] = useState<number>(1);
  const [live, setLive] = useState<boolean>(false);

  // Sessions
  const { data: sessions, isLoading: sessionsLoading, mutate: refetchSessions } = useSWR(["sessions", filters],
    () => getSessions(filters), { revalidateOnFocus: false });

  // Laps for selected session
  const { data: laps, isLoading: lapsLoading } = useSWR(sessionId ? ["laps", sessionId] : null, () => getLaps(sessionId!), { revalidateOnFocus: false });

  // Telemetry for selected lap
  const { data: telemetry, isLoading: telLoading, mutate: refetchTelemetry } = useSWR(
    sessionId && selectedLap ? ["telemetry", sessionId, selectedLap, live] : null,
    () => getTelemetry(sessionId!, selectedLap!),
    { refreshInterval: live ? 1000 : 0, revalidateOnFocus: false }
  );

  useEffect(() => {
    // Select first session + first lap by default
    if (!sessionId && sessions && sessions.length) setSessionId(sessions[0].id);
  }, [sessions, sessionId]);

  useEffect(() => {
    if (!selectedLap && laps && laps.length) setSelectedLap(laps[0].lap);
  }, [laps, selectedLap]);

  return (
    <div className="min-h-screen w-full bg-neutral-100 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-4">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Gauge className="w-7 h-7"/>
            <div>
              <h1 className="text-2xl font-semibold">Telemetry Dashboard</h1>
              <p className="text-sm text-neutral-500">Point to your FastAPI backend with <code className="px-1 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800">VITE_API_BASE</code></p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant={live?"destructive":"default"} onClick={()=>setLive(!live)}>{live? <><PauseCircle className="w-4 h-4 mr-1"/>Stop Live</> : <><PlayCircle className="w-4 h-4 mr-1"/>Start Live</>}</Button>
            <Button variant="outline" onClick={()=>{refetchSessions(); if(sessionId&&selectedLap) refetchTelemetry();}}><RefreshCw className="w-4 h-4 mr-1"/>Refresh</Button>
            <Button variant="ghost"><Settings className="w-4 h-4 mr-1"/>Settings</Button>
          </div>
        </header>

        <SessionFilters value={filters} onChange={setFilters} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <Card className="rounded-2xl shadow-sm">
              <CardContent className="p-4 md:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2"><Activity className="w-4 h-4"/><span className="font-medium">Timeseries</span></div>
                  <div className="flex items-center gap-3">
                    <Select value={metric} onValueChange={(v)=>setMetric(v as MetricKey)}>
                      <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Metric</SelectLabel>
                          {METRICS.map(m => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-neutral-500">Smoothing</span>
                      <Slider className="w-[140px]" min={1} max={21} step={2} value={[smoothing]} onValueChange={(v)=>setSmoothing(v[0])} />
                      <Badge variant="secondary">{smoothing} pt</Badge>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border bg-white dark:bg-neutral-900">
                  {telLoading ? (
                    <div className="p-6 text-sm text-neutral-500">Loading telemetry…</div>
                  ) : telemetry && telemetry.length ? (
                    <TelemetryChart data={telemetry} metric={metric} smoothing={smoothing} />
                  ) : (
                    <div className="p-6 text-sm text-neutral-500">Select a session and lap to view telemetry.</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <CardContent className="p-4 md:p-6 space-y-4">
                <div className="flex items-center gap-2"><MapPin className="w-4 h-4"/><span className="font-medium">Track Position (Lat/Lon)</span></div>
                <div className="h-[260px] rounded-xl border bg-white dark:bg-neutral-900 p-2 flex items-center justify-center">
                  {/* Minimal placeholder: if lat/lon are present, render a simple scatter via SVG */}
                  <TrackScatter points={telemetry ?? []} />
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="rounded-2xl shadow-sm">
              <CardContent className="p-4 md:p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2"><ListFilter className="w-4 h-4"/><span className="font-medium">Session</span></div>
                </div>

                {sessionsLoading ? (
                  <div className="text-sm text-neutral-500">Loading sessions…</div>
                ) : sessions && sessions.length ? (
                  <div className="space-y-3">
                    <SessionTable sessions={sessions} selectedId={sessionId} onSelect={(id)=>{setSessionId(id); setSelectedLap(undefined);}} />
                  </div>
                ) : (
                  <div className="text-sm text-neutral-500">No sessions found.</div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <CardContent className="p-4 md:p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2"><Activity className="w-4 h-4"/><span className="font-medium">Lap</span></div>
                </div>

                {lapsLoading ? (
                  <div className="text-sm text-neutral-500">Loading laps…</div>
                ) : laps && laps.length ? (
                  <div className="space-y-3">
                    <LapPicker laps={laps} value={selectedLap} onChange={setSelectedLap} />
                    {selectedLap && <div className="text-xs text-neutral-500">Lap {selectedLap} • {laps.find(l=>l.lap===selectedLap)?.time_ms ? ms(laps.find(l=>l.lap===selectedLap)!.time_ms!) : ""}</div>}
                  </div>
                ) : (
                  <div className="text-sm text-neutral-500">Select a session to see laps.</div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-2xl shadow-sm">
              <CardContent className="p-4 md:p-6 space-y-2">
                <div className="flex items-center gap-2"><UploadCloud className="w-4 h-4"/><span className="font-medium">Import</span></div>
                <p className="text-sm text-neutral-500">Drag a CSV/JSON of telemetry and preview it here (hook up your parser in <code>getTelemetry</code>).</p>
                <Button variant="secondary" size="sm">Upload file</Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------------------
// Lightweight Lat/Lon Scatter (SVG)
// -------------------------------
function TrackScatter({ points }: { points: TelemetryPointT[] }) {
  const pts = points.filter(p=>typeof p.lat==='number' && typeof p.lon==='number') as Required<Pick<TelemetryPointT,'lat'|'lon'>>[];
  if (!pts.length) return <div className="text-sm text-neutral-500">No GPS data in this lap.</div>;
  const lats = pts.map(p=>p.lat!); const lons = pts.map(p=>p.lon!);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 8; const W = 520, H = 220;
  const x = (lon:number)=> pad + (lon - minLon) / Math.max(1e-9, (maxLon - minLon)) * (W - 2*pad);
  const y = (lat:number)=> pad + (maxLat - lat) / Math.max(1e-9, (maxLat - minLat)) * (H - 2*pad);
  const d = pts.map((p,i)=>`${i===0?"M":"L"}${x(p.lon!)},${y(p.lat!)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full">
      <rect x={0} y={0} width={W} height={H} rx={12} className="fill-transparent stroke-[0.5]" />
      <path d={d} fill="none" strokeWidth={2} />
    </svg>
  );
}
