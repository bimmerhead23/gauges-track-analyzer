import type { Lap, MathChannel, Session, Track } from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = r.statusText || `HTTP ${r.status}`;
    try {
      const t = await r.text();
      try {
        const j = JSON.parse(t);
        const d = j.detail;
        msg = Array.isArray(d) ? JSON.stringify(d) : d || t || msg;
      } catch {
        if (t) msg = t;
      }
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  health: () => req<{ ok: boolean; demo?: boolean }>("/api/health"),
  sessions: () => req<Session[]>("/api/sessions"),
  vehicles: () => req<{ vehicles: string[] }>("/api/sessions/vehicles"),
  session: (id: number) => req<Session>(`/api/sessions/${id}`),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<Session>("/api/sessions/upload", { method: "POST", body: fd });
  },
  patchSession: (id: number, body: Partial<Session>) =>
    req<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  reprocess: (id: number) => req<Session>(`/api/sessions/${id}/reprocess`, { method: "POST" }),
  deleteSession: (id: number) => req(`/api/sessions/${id}`, { method: "DELETE" }),
  resetDatabase: () => req<{ ok: boolean; sessions: number; tracks: number }>("/api/sessions/reset", { method: "POST" }),
  backupDownload: () => {
    const stamp = new Date().toISOString().slice(0, 10);
    return api.download("/api/backup", `gauges-library-${stamp}.gsbak`);
  },
  restoreBackup: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<{ ok: boolean; sessions: number; restored: number }>("/api/backup/restore", {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(300000),
    });
  },
  tracks: () => req<Track[]>("/api/tracks"),
  patchLayout: (id: number, body: object) =>
    req(`/api/tracks/layouts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  proposeSf: (layoutId: number, sessionId: number) =>
    req(`/api/tracks/layouts/${layoutId}/propose-sf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    }),
  laps: (sessionId: number) => req<Lap[]>(`/api/laps?session_id=${sessionId}`),
  patchLap: (id: number, kind: string) =>
    req<Lap>(`/api/laps/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    }),
  traces: (lapIds: number[], channels: string[]) =>
    req(`/api/traces?lap_ids=${lapIds.join(",")}&channels=${channels.join(",")}`),
  cursor: (lapIds: number[], dist: number, channels: string[]) =>
    req(`/api/cursor?lap_ids=${lapIds.join(",")}&dist_m=${dist}&channels=${channels.join(",")}`),
  ab: (lapIds: number[], distA: number, distB: number, channels: string[]) => {
    const q = new URLSearchParams({
      lap_ids: lapIds.join(","),
      dist_a: String(distA),
      dist_b: String(distB),
      channels: channels.join(","),
    });
    return req(`/api/ab?${q.toString()}`);
  },
  delta: (ref: number, lapIds: number[]) =>
    req(`/api/delta?ref_lap_id=${ref}&lap_ids=${lapIds.join(",")}`),
  map: (lapIds: number[]) => req(`/api/map?lap_ids=${lapIds.join(",")}`),
  download: async (url: string, filename: string) => {
    const r = await fetch(url);
    if (!r.ok) {
      let msg = r.statusText || `HTTP ${r.status}`;
      try {
        const t = await r.text();
        try {
          const j = JSON.parse(t);
          msg = j.detail || t;
        } catch {
          if (t) msg = t;
        }
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  exportLapsCsv: (lapIds: number[], filename: string) =>
    api.download(`/api/export/laps.csv?lap_ids=${lapIds.join(",")}`, filename),
  originalCsv: (sessionId: number, filename: string) =>
    api.download(`/api/sessions/${sessionId}/original.csv`, filename),
  splits: (lapIds: number[], channels?: string[]) => {
    const q = new URLSearchParams({ lap_ids: lapIds.join(",") });
    if (channels?.length) q.set("channels", channels.join(","));
    return req(`/api/splits?${q.toString()}`);
  },
  report: (lapIds: number[], channels: string[], opts?: { gates?: string; distMin?: number; distMax?: number }) => {
    const q = new URLSearchParams({ lap_ids: lapIds.join(","), channels: channels.join(",") });
    if (opts?.gates) q.set("gates", opts.gates);
    if (opts?.distMin != null) q.set("dist_min", String(opts.distMin));
    if (opts?.distMax != null) q.set("dist_max", String(opts.distMax));
    return req(`/api/report?${q.toString()}`);
  },
  scatter: (
    lapIds: number[],
    x: string,
    y: string,
    opts?: { gates?: string; distMin?: number; distMax?: number },
  ) => {
    const q = new URLSearchParams({ lap_ids: lapIds.join(","), x, y });
    if (opts?.gates) q.set("gates", opts.gates);
    if (opts?.distMin != null) q.set("dist_min", String(opts.distMin));
    if (opts?.distMax != null) q.set("dist_max", String(opts.distMax));
    return req(`/api/scatter?${q.toString()}`);
  },
  histogram: (
    lapIds: number[],
    channel: string,
    opts?: { bins?: number; distMin?: number; distMax?: number; threshold?: number | null; gates?: string },
  ) => {
    const q = new URLSearchParams({
      lap_ids: lapIds.join(","),
      channel,
      bins: String(opts?.bins ?? 24),
    });
    if (opts?.distMin != null) q.set("dist_min", String(opts.distMin));
    if (opts?.distMax != null) q.set("dist_max", String(opts.distMax));
    if (opts?.threshold != null && Number.isFinite(opts.threshold)) q.set("threshold", String(opts.threshold));
    if (opts?.gates) q.set("gates", opts.gates);
    return req(`/api/histogram?${q.toString()}`);
  },
  afrMap: (lapIds: number[], opts?: { gates?: string; distMin?: number; distMax?: number }) => {
    const q = new URLSearchParams({ lap_ids: lapIds.join(",") });
    if (opts?.gates) q.set("gates", opts.gates);
    if (opts?.distMin != null) q.set("dist_min", String(opts.distMin));
    if (opts?.distMax != null) q.set("dist_max", String(opts.distMax));
    return req(`/api/afr-map?${q.toString()}`);
  },
  coachStatus: () => req<{ ok: boolean; reason: string; provider: string; model: string }>("/api/coach/status"),
  coach: (body: object) =>
    req("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    }),
  math: () => req<MathChannel[]>("/api/math-channels"),
  createMath: (body: object) =>
    req("/api/math-channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteMath: (id: number) => req(`/api/math-channels/${id}`, { method: "DELETE" }),
};
