// src/TelemetryDashboard.tsx
import React, { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const API_BASE = (import.meta as any)?.env?.VITE_API_BASE
  || (window as any)?.API_BASE
  || "http://127.0.0.1:8000";

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

const driverNumberToInfo2024: Record<string, { code: string; name: string }> = {
  "1":  { code: "VER", name: "Max Verstappen" },
  "3":  { code: "RIC", name: "Daniel Ricciardo" },
  "4":  { code: "NOR", name: "Lando Norris" },
  "10": { code: "GAS", name: "Pierre Gasly" },
  "11": { code: "PER", name: "Sergio Pérez" },
  "14": { code: "ALO", name: "Fernando Alonso" },
  "16": { code: "LEC", name: "Charles Leclerc" },
  "18": { code: "STR", name: "Lance Stroll" },
  "20": { code: "MAG", name: "Kevin Magnussen" },
  "22": { code: "TSU", name: "Yuki Tsunoda" },
  "23": { code: "ALB", name: "Alex Albon" },
  "24": { code: "ZHO", name: "Zhou Guanyu" },
  "27": { code: "HUL", name: "Nico Hülkenberg" },
  "30": { code: "LAW", name: "Liam Lawson" },
  "31": { code: "OCO", name: "Esteban Ocon" },
  "44": { code: "HAM", name: "Lewis Hamilton" },
  "55": { code: "SAI", name: "Carlos Sainz Jr." },
  "63": { code: "RUS", name: "George Russell" },
  "77": { code: "BOT", name: "Valtteri Bottas" },
  "81": { code: "PIA", name: "Oscar Piastri" }
};

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
  const url = `${API_BASE}/sessions/${sessionId}/drivers`;
  const raw = await fetcher(url);
  const arr: any[] = Array.isArray(raw) ? raw : (raw.drivers ?? []);
  return arr.map((d: any) => {
    return DriverSchema.parse({
      driverId: String(d.driver_id),
      driver_number: d.driver_number !== undefined ? String(d.driver_number) : undefined,
      code: String(d.code),
      name: String(d.name),
    });
  });
}

async function fetchDriverTelemetry(
  sessionId: string,
  driverCode: string,
  setTelemetry: React.Dispatch<React.SetStateAction<Record<string, any>>>
): Promise<void> {
  try {
    const fastestLapUrl = `${API_BASE}/sessions/${sessionId}/fastest-lap?driver=${driverCode}&only_by_time=true`;
    console.log("[TelemetryDashboard] fetching fastest-lap for", driverCode, fastestLapUrl);
    const lapRes: any = await fetcher(fastestLapUrl);
    const lapNumber = String(lapRes.lap_number ?? lapRes.lapNumber);
    const lapId = `${sessionId}_${driverCode}_${lapNumber}`;
    const telemetryUrl = `${API_BASE}/laps/${lapId}/telemetry?start=0&end=5&mode=time`;
    console.log("[TelemetryDashboard] fetching telemetry for", driverCode, telemetryUrl);
    const telemetry = await fetcher(telemetryUrl);
    setTelemetry((prev) => ({ ...prev, [driverCode]: telemetry }));
  } catch (err) {
    console.error("[TelemetryDashboard] Error fetching telemetry for driver:", driverCode, err);
  }
}

export default function TelemetryDashboard() {
  const [yearFilter, setYearFilter] = useState<string | undefined>(undefined);
  const [eventFilter, setEventFilter] = useState<string | undefined>(undefined);
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>([]);
  const [drivers, setDrivers] = useState<DriverT[]>([]);
  const [telemetryData, setTelemetryData] = useState<Record<string, any>>({});

  const { data: sessions, isLoading: sessionsLoading, error: sessionsError } = useSWR(
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
      getDriversForSession(qualifyingSession.id)
        .then(setDrivers)
        .catch(err => console.error("[TelemetryDashboard] Error fetching drivers:", err));
      setSelectedDrivers([]);
      setTelemetryData({});
    }
  }, [qualifyingSession]);

  useEffect(() => {
    if (!qualifyingSession) return;
    selectedDrivers.forEach(driverNumber => {
      const info = driverNumberToInfo2024[driverNumber];
      const driverCode = info ? info.code : undefined;
      if (!driverCode) return;
      fetchDriverTelemetry(qualifyingSession.id, driverCode, setTelemetryData);
    });
  }, [selectedDrivers, qualifyingSession]);

  return (
    <div className="max-w-4xl mx-auto p-4">
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
          <SelectTrigger className="w-[120px]"><SelectValue placeholder="Year" /></SelectTrigger>
          <SelectContent>
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
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Event" /></SelectTrigger>
          <SelectContent>
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
              const info = driverNumberToInfo2024[num];
              const displayName = info ? info.name : d.name;
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
          <ul className="list-none p-0 flex gap-2 mt-1">
            {selectedDrivers.map((driverNumber) => {
              const info = driverNumberToInfo2024[driverNumber];
              const name = info ? info.name : driverNumber;
              return (
                <li key={driverNumber} className="px-2 py-1 bg-gray-100 rounded-md text-sm">
                  {name} (#{driverNumber})
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {selectedDrivers.length > 0 && (
        <div className="mt-6">
          <h2 className="text-xl font-medium mb-2">Telemetry Comparison</h2>
          {selectedDrivers.map(driverNumber => {
            const info = driverNumberToInfo2024[driverNumber];
            const driverCode = info ? info.code : driverNumber;
            return (
              <div key={driverNumber} className="mb-4">
                <h3>{info ? info.name : driverNumber} (#{driverNumber})</h3>
                <pre>{JSON.stringify(telemetryData[driverCode] ?? {}, null, 2)}</pre>
              </div>
            );
          })}
        </div>
      )}

      {sessionsLoading && <div className="text-center p-4 text-gray-500">Loading sessions…</div>}

      {!sessionsLoading && !qualifyingSession && yearFilter && eventFilter && (
        <div className="text-center text-gray-500 p-4">
          No qualifying session found for the selected event.
        </div>
      )}
    </div>
  );
}