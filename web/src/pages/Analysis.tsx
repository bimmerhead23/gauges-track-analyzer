import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import L from "leaflet";
import uPlot from "uplot";
import { api } from "../api";
import { exportViewPng } from "../exportPng";
import { channelAxisLabel, fmtDelta, fmtLap, fmtNum } from "../format";
import LogSheetForm, { sheetFilled } from "../LogSheet";
import MathChannels from "../components/MathChannels";
import MechanicalStrip from "../components/MechanicalStrip";
import SetupCompare from "../components/SetupCompare";
import TurnRail from "../components/TurnRail";
import { cssVar, useTheme } from "../theme";
import { LAP_COLORS, type Channel, type Gate, type Lap, type Layout, type MathChannel, type Session } from "../types";
import {
  UNITS_KEY,
  UnitPrefContext,
  convertMaybe,
  convertScaleMap,
  convertValue,
  convertY,
  displayChannel,
  inferPrefFromChannels,
  loadUnitPref,
  preferredUnit,
  remapSpeedKey,
  useUnitPref,
  visibleChannels,
  type UnitPref,
} from "../units";

function plotTheme() {
  return {
    bg: cssVar("--plot-bg", "#161b22"),
    grid: cssVar("--plot-grid", "#21262d"),
    axis: cssVar("--plot-axis", "#8b949e"),
    tick: cssVar("--plot-tick", "#30363d"),
    labelBg: cssVar("--cursor-label-bg", "rgba(13, 17, 23, 0.94)"),
    labelFg: cssVar("--cursor-label-fg", "#e6edf3"),
    text: cssVar("--text", "#e6edf3"),
    muted: cssVar("--muted", "#8b949e"),
  };
}

type Tab = "traces" | "splits" | "histogram" | "afr" | "report" | "track" | "coach";

const TAB_LABEL: Record<Tab, string> = {
  traces: "Overlay",
  splits: "Splits",
  histogram: "Histogram",
  afr: "AFR",
  report: "Report",
  track: "Track",
  coach: "Coach",
};

const DEFAULT_CH = ["gps_speed_mph", "rpm", "tps", "brake"];
const PLOTTED_KEY = "ta-plotted";
const MAP_W_KEY = "ta-map-width";
const SCALE_KEY = "ta-ch-scale";
const MAP_COLOR_KEY = "ta-map-color";
const MAP_W_DEFAULT = 280;
const GATE_KEY = "ta-gate";
type GateOp = ">" | ">=" | "<" | "<=";
type DataGate = { channel: string; op: GateOp; value: number };
type GatePreset = "off" | "braking" | "throttle" | "speed" | "coasting" | "custom";
const GATE_OPS: GateOp[] = [">", ">=", "<", "<="];
const GATE_PRESETS: { id: GatePreset; label: string; gates: DataGate[] }[] = [
  { id: "off", label: "Off", gates: [] },
  { id: "braking", label: "Braking", gates: [{ channel: "brake", op: ">", value: 10 }] },
  { id: "throttle", label: "Full throttle", gates: [{ channel: "tps", op: ">", value: 70 }] },
  { id: "speed", label: "Speed ≥ 80", gates: [{ channel: "gps_speed_mph", op: ">=", value: 80 }] },
  { id: "coasting", label: "Coasting", gates: [
    { channel: "tps", op: "<", value: 5 },
    { channel: "brake", op: "<", value: 5 },
  ]},
  { id: "custom", label: "Custom", gates: [{ channel: "brake", op: ">", value: 10 }] },
];

function encodeGates(gates: DataGate[]): string {
  return gates
    .filter((g) => g.channel && Number.isFinite(g.value))
    .map((g) => `${g.channel}${g.op}${g.value}`)
    .join(",");
}

function gateSummary(gates: DataGate[], channels: Channel[]): string {
  if (!gates.length) return "all data";
  return gates
    .map((g) => {
      const name = channels.find((c) => c.key === g.channel)?.name || g.channel;
      return `${name} ${g.op} ${g.value}`;
    })
    .join(" and ");
}

function loadGate(): { preset: GatePreset; gates: DataGate[] } {
  try {
    const parsed = JSON.parse(localStorage.getItem(GATE_KEY) || "");
    if (parsed && GATE_PRESETS.some((p) => p.id === parsed.preset) && Array.isArray(parsed.gates)) {
      return { preset: parsed.preset, gates: parsed.gates };
    }
  } catch {
    /* keep default */
  }
  return { preset: "off", gates: [] };
}
const MAP_COLOR_OPTS = [
  { key: "lap", label: "Lap" },
  { key: "gps_speed_mph", label: "Speed" },
  { key: "tps", label: "Throttle" },
  { key: "brake", label: "Brake" },
  { key: "afr", label: "AFR" },
] as const;
const MAP_COLOR_META: Record<string, { name: string; unit: string }> = {
  gps_speed_mph: { name: "GPS Speed", unit: "mph" },
  tps: { name: "Throttle", unit: "%" },
  brake: { name: "Brake", unit: "%" },
  afr: { name: "AFR", unit: "" },
};
const HEAT_STOPS: [number, number, number, number][] = [
  [0, 59, 76, 192],
  [0.25, 111, 168, 220],
  [0.5, 77, 175, 74],
  [0.75, 255, 224, 102],
  [1, 215, 48, 39],
];

function heatColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  const q = Math.round(x * 20) / 20;
  let a = HEAT_STOPS[0];
  let b = HEAT_STOPS[HEAT_STOPS.length - 1];
  for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
    if (q >= HEAT_STOPS[i][0] && q <= HEAT_STOPS[i + 1][0]) {
      a = HEAT_STOPS[i];
      b = HEAT_STOPS[i + 1];
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const u = (q - a[0]) / span;
  const r = Math.round(a[1] + (b[1] - a[1]) * u);
  const g = Math.round(a[2] + (b[2] - a[2]) * u);
  const bl = Math.round(a[3] + (b[3] - a[3]) * u);
  return `rgb(${r},${g},${bl})`;
}

function rainbowRange(key: string, values: number[]): { min: number; max: number } | null {
  if (!values.length) return null;
  if (key === "tps" || key === "brake") return { min: 0, max: Math.max(...values, 1) };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  let lo = at(0.02);
  let hi = at(0.98);
  if (hi - lo < 1e-3) {
    lo = s[0];
    hi = s[s.length - 1];
  }
  if (hi - lo < 1e-3) hi = lo + 1;
  return { min: lo, max: hi };
}

function loadMapColor(): string {
  try {
    const v = localStorage.getItem(MAP_COLOR_KEY) || "";
    if (MAP_COLOR_OPTS.some((o) => o.key === v)) return v;
  } catch {
    /* keep default */
  }
  return "gps_speed_mph";
}

type ChScale = { min: number | null; max: number | null };

function loadPlotted(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLOTTED_KEY) || "");
    if (Array.isArray(parsed) && parsed.length && parsed.every((x) => typeof x === "string")) return parsed;
  } catch {
    /* keep defaults */
  }
  return DEFAULT_CH;
}

function existingPlotted(plotted: string[], channels: Channel[]): string[] {
  const have = new Set(channels.map((c) => c.key));
  return plotted.filter((k) => k === "delta_t" || have.has(k));
}

function loadMapWidth(): number {
  const n = Number(localStorage.getItem(MAP_W_KEY));
  return Number.isFinite(n) && n >= 180 && n <= 900 ? n : MAP_W_DEFAULT;
}

function loadScales(): Record<string, ChScale> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCALE_KEY) || "");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* keep empty */
  }
  return {};
}

function channelDataRange(traces: any[], key: string): { min: number; max: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of traces) {
    const y = t.series?.[key]?.y as (number | null)[] | undefined;
    if (!y) continue;
    for (const v of y) {
      if (v == null || Number.isNaN(Number(v))) continue;
      const n = Number(v);
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { min: lo, max: hi };
}

export default function Analysis() {
  const [params] = useSearchParams();
  const sessionIds = (params.get("sessions") || "")
    .split(",")
    .map(Number)
    .filter(Boolean);
  const lapIdsParam = (params.get("laps") || "")
    .split(",")
    .map(Number)
    .filter(Boolean);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [refId, setRefId] = useState<number | null>(null);
  const [plotted, setPlotted] = useState<string[]>(loadPlotted);
  const [mapWidth, setMapWidth] = useState(loadMapWidth);
  const [mapColor, setMapColor] = useState(loadMapColor);
  const [chScale, setChScale] = useState<Record<string, ChScale>>(loadScales);
  const loadedGate = useMemo(loadGate, []);
  const [gatePreset, setGatePreset] = useState<GatePreset>(loadedGate.preset);
  const [gates, setGates] = useState<DataGate[]>(loadedGate.gates);
  const [mapResizing, setMapResizing] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [cursorDist, setCursorDist] = useState(0);
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const [markA, setMarkA] = useState<number | null>(null);
  const [markB, setMarkB] = useState<number | null>(null);
  const markARef = useRef<number | null>(null);
  markARef.current = markA;
  const [abData, setAbData] = useState<any>(null);
  const [hoverDist, setHoverDist] = useState<number | null>(null);
  const mapCursorRef = useRef<(d: number | null) => void>(() => {});
  const scatterCursorRef = useRef<(d: number | null) => void>(() => {});
  const [xRange, setXRange] = useState<[number, number] | null>(null);
  const [dragRange, setDragRange] = useState<[number, number] | null>(null);
  const [cursorVals, setCursorVals] = useState<any>(null);
  const [traces, setTraces] = useState<any[]>([]);
  const [delta, setDelta] = useState<any>(null);
  const [mapData, setMapData] = useState<any[]>([]);
  const [turns, setTurns] = useState<{ n: number; apex_m: number; d0_m: number; d1_m: number; name?: string | null }[]>([]);
  const [tab, setTab] = useState<Tab>("traces");
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [math, setMath] = useState<MathChannel[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportErr, setExportErr] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [unitPref, setUnitPref] = useState<UnitPref>(() => loadUnitPref() || "imperial");
  const userSetUnits = useRef(loadUnitPref() != null);

  const laps: Lap[] = useMemo(
    () => sessions.flatMap((s) => (s.laps || []).map((l) => ({ ...l, session_id: s.id }))),
    [sessions]
  );
  const channels: Channel[] = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const s of sessions) for (const c of s.channels || []) m.set(c.key, c);
    for (const mc of math) {
      if (!mc.enabled) continue;
      m.set(mc.key, { key: mc.key, name: mc.name, unit: mc.unit, source: "math" });
    }
    return [...m.values()];
  }, [sessions, math]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const ss = await Promise.all(
          (sessionIds.length ? sessionIds : []).map((id) => api.session(id))
        );
        if (cancel) return;
        if (!ss.length) {
          const all = await api.sessions();
          if (all[0]) ss.push(await api.session(all[0].id));
        }
        setSessions(ss);
        const saved = ss.find((s) => s.analysis_settings && (s.analysis_settings.plotted?.length || s.analysis_settings.gatePreset || s.analysis_settings.mapColor))?.analysis_settings;
        if (saved) {
          if (saved.plotted?.length) setPlotted(saved.plotted);
          if (saved.chScale && typeof saved.chScale === "object") setChScale(saved.chScale);
          if (typeof saved.mapWidth === "number" && saved.mapWidth >= 180 && saved.mapWidth <= 900) setMapWidth(saved.mapWidth);
          if (saved.mapColor && MAP_COLOR_OPTS.some((o) => o.key === saved.mapColor)) setMapColor(saved.mapColor);
          const gp = GATE_PRESETS.find((p) => p.id === saved.gatePreset);
          if (gp) {
            setGatePreset(gp.id);
            setGates(Array.isArray(saved.gates) && saved.gates.length ? (saved.gates as DataGate[]) : gp.gates);
          }
          if (saved.units === "metric" || saved.units === "imperial") {
            setUnitPref(saved.units);
            userSetUnits.current = true;
          }
        }
        setHydrated(true);
        const allLaps = ss.flatMap((s) => s.laps || []);
        const valid = allLaps.filter((l) => l.kind === "valid");
        const have = new Set(allLaps.map((l) => l.id));
        const fromUrl = lapIdsParam.filter((id) => have.has(id));
        const best = [...valid].sort((a, b) => a.time_ms - b.time_ms)[0];
        const pick = fromUrl.length
          ? fromUrl
          : best
            ? [best.id]
            : valid.length
              ? valid.slice(0, 2).map((l) => l.id)
              : allLaps.map((l) => l.id);
        setSelected(pick);
        const chosen = allLaps.filter((l) => pick.includes(l.id));
        const pool = chosen.filter((l) => l.kind === "valid");
        const ref = (pool.length ? pool : chosen).sort((a, b) => a.time_ms - b.time_ms)[0];
        setRefId(ref?.id ?? best?.id ?? pick[0] ?? null);
        api.math().then(setMath).catch(() => {});
      } catch (e: any) {
        setErr(e.message || String(e));
      }
    })();
    return () => {
      cancel = true;
      setHydrated(false);
    };
  }, [params]);

  useEffect(() => {
    if (!hydrated || !sessions.length) return;
    const t = window.setTimeout(() => {
      const analysis_settings = { plotted, chScale, mapWidth, mapColor, gatePreset, gates, units: unitPref };
      for (const s of sessions) {
        api.patchSession(s.id, { analysis_settings }).catch(() => {});
      }
    }, 600);
    return () => window.clearTimeout(t);
  }, [hydrated, sessions.map((s) => s.id).join(","), plotted, chScale, mapWidth, mapColor, gatePreset, gates, unitPref]);

  useEffect(() => {
    if (!exportOpen) return;
    const on = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".export-wrap")) setExportOpen(false);
    };
    window.addEventListener("mousedown", on);
    return () => window.removeEventListener("mousedown", on);
  }, [exportOpen]);

  useEffect(() => {
    const chosen = laps.filter((l) => selected.includes(l.id));
    if (!chosen.length) return;
    const flying = chosen.filter((l) => l.kind === "valid");
    const pool = flying.length ? flying : chosen;
    const fastest = [...pool].sort((a, b) => a.time_ms - b.time_ms)[0];
    if (fastest) setRefId(fastest.id);
  }, [selected.join(","), laps.map((l) => `${l.id}:${l.time_ms}:${l.kind}`).join(",")]);

  const listChannels = useMemo(() => visibleChannels(channels, unitPref), [channels, unitPref]);
  const plotKeys = useMemo(() => {
    const remapped = plotted.map((k) => remapSpeedKey(k, channels, unitPref));
    return existingPlotted([...new Set(remapped)], listChannels);
  }, [plotted, listChannels, channels, unitPref]);

  useEffect(() => {
    if (userSetUnits.current || !channels.length) return;
    const inf = inferPrefFromChannels(channels);
    if (inf) setUnitPref(inf);
  }, [channels]);

  function applyUnitPref(next: UnitPref) {
    if (next === unitPref) return;
    setPlotted((p) => [...new Set(p.map((k) => remapSpeedKey(k, channels, next)))]);
    setChScale((s) => convertScaleMap(s, channels, unitPref, next));
    setGates((gs) =>
      gs.map((g) => {
        const ch = channels.find((c) => c.key === g.channel);
        if (!ch) return { ...g, channel: remapSpeedKey(g.channel, channels, next) };
        const fromU = preferredUnit(ch.unit, unitPref);
        const toU = preferredUnit(ch.unit, next);
        return {
          ...g,
          channel: remapSpeedKey(g.channel, channels, next),
          value: convertValue(g.value, fromU, toU),
        };
      })
    );
    userSetUnits.current = true;
    setUnitPref(next);
    try {
      localStorage.setItem(UNITS_KEY, next);
    } catch {
      /* ignore */
    }
  }
  const plotKeySig = plotKeys.join(",");
  const channelKeySig = channels.map((c) => c.key).join(",");

  useEffect(() => {
    if (!selected.length) return;
    const ch = plotKeys.filter((c) => c !== "delta_t");
    if (ch.length) {
      api.traces(selected, ch, refId).then(setTraces).catch((e) => setErr(String(e)));
    } else {
      setTraces([]);
    }
    api.map(selected, refId).then((res) => {
      setMapData(Array.isArray(res) ? res : res.laps || []);
      setTurns(Array.isArray(res) ? [] : res.turns || []);
    }).catch(() => {});
    if (refId) api.delta(refId, selected).then(setDelta).catch(() => {});
  }, [selected.join(","), plotKeySig, refId, channelKeySig]);

  useEffect(() => {
    if (!pinned || !selected.length || !plotKeys.length) {
      if (!pinned) setCursorVals(null);
      return;
    }
    api.cursor(selected, cursorDist, plotKeys, refId).then(setCursorVals).catch(() => {});
  }, [pinned, cursorDist, selected.join(","), plotKeySig, refId]);

  const abB = markB != null ? markB : markA != null ? hoverDist : null;
  useEffect(() => {
    if (markA == null || abB == null || !selected.length || Math.abs(abB - markA) < 2) {
      setAbData(null);
      return;
    }
    const ch = plotKeys.filter((c) => c !== "delta_t");
    const delay = markB != null ? 0 : 140;
    const t = window.setTimeout(() => {
      api.ab(selected, markA, abB, ch.length ? ch : ["gps_speed_mph", "tps"], refId).then(setAbData).catch(() => setAbData(null));
    }, delay);
    return () => window.clearTimeout(t);
  }, [markA, abB, markB, selected.join(","), plotKeySig, refId]);

  function reportHover(dist: number | null) {
    setHoverDist(dist);
    mapCursorRef.current(dist);
    scatterCursorRef.current(dist);
  }
  function pinAt(dist: number, shift = false) {
    setCursorDist(dist);
    setPinned(true);
    mapCursorRef.current(dist);
    scatterCursorRef.current(dist);
    if (shift || markARef.current == null) {
      setMarkA(dist);
      if (!shift) setMarkB(null);
      return;
    }
    setMarkB(dist);
  }
  function unpin() {
    setPinned(false);
    setCursorVals(null);
    setMarkA(null);
    setMarkB(null);
    setAbData(null);
    mapCursorRef.current(null);
    scatterCursorRef.current(null);
  }
  function zoomTo(range: [number, number]) {
    const lo = Math.min(range[0], range[1]);
    const hi = Math.max(range[0], range[1]);
    if (hi - lo < 5) return;
    setDragRange(null);
    setXRange([lo, hi]);
  }
  function resetView() {
    setXRange(null);
    setDragRange(null);
    unpin();
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") unpin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const highlightRange = dragRange || xRange;

  function colorFor(lapId: number) {
    const i = selected.indexOf(lapId);
    return LAP_COLORS[(i < 0 ? 0 : i) % LAP_COLORS.length];
  }
  function sessionTag(sessionId: number) {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return "";
    if (s.started_at) {
      const d = new Date(s.started_at);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      }
    }
    return s.filename.replace(/\.csv$/i, "");
  }

  function toggleLap(id: number) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function toggleCh(key: string) {
    const speed = key === "gps_speed" || key === "gps_speed_mph";
    setPlotted((p) => {
      const visible = p.map((k) => remapSpeedKey(k, channels, unitPref));
      const on = visible.includes(key) || p.includes(key);
      const stripped = p.filter((k) => {
        if (speed && (k === "gps_speed" || k === "gps_speed_mph")) return false;
        return k !== key;
      });
      return on ? stripped : [...stripped, key];
    });
  }
  function reorderPlotted(from: string, to: string, after: boolean) {
    setPlotted((p) => {
      if (from === to) return p;
      const next = p.filter((k) => k !== from);
      let i = next.indexOf(to);
      if (i < 0) return p;
      if (after) i += 1;
      next.splice(i, 0, from);
      return next;
    });
  }

  useEffect(() => {
    localStorage.setItem(PLOTTED_KEY, JSON.stringify(plotted));
  }, [plotted]);
  useEffect(() => {
    localStorage.setItem(MAP_W_KEY, String(mapWidth));
  }, [mapWidth]);
  useEffect(() => {
    localStorage.setItem(SCALE_KEY, JSON.stringify(chScale));
  }, [chScale]);
  useEffect(() => {
    localStorage.setItem(MAP_COLOR_KEY, mapColor);
  }, [mapColor]);
  useEffect(() => {
    localStorage.setItem(GATE_KEY, JSON.stringify({ preset: gatePreset, gates }));
  }, [gatePreset, gates]);
  function resetAnalysisSettings() {
    setPlotted(DEFAULT_CH);
    setChScale({});
    setMapWidth(MAP_W_DEFAULT);
    setMapColor("gps_speed_mph");
    setGatePreset("off");
    setGates([]);
    setXRange(null);
    setDragRange(null);
  }

  function setMapColorPersist(key: string) {
    setMapColor(key);
    try {
      localStorage.setItem(MAP_COLOR_KEY, key);
    } catch {
      /* ignore */
    }
  }

  function setChannelScale(key: string, patch: Partial<ChScale>) {
    setChScale((s) => {
      const cur = s[key] || { min: null, max: null };
      const next = { ...cur, ...patch };
      if (next.min == null && next.max == null) {
        const rest = { ...s };
        delete rest[key];
        return rest;
      }
      return { ...s, [key]: next };
    });
  }

  function startMapResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const ws = workspaceRef.current;
    if (!ws) return;
    setMapResizing(true);
    const onMove = (ev: PointerEvent) => {
      const rect = ws.getBoundingClientRect();
      const max = Math.max(200, rect.width - 280 - 240 - 16);
      setMapWidth(Math.round(Math.min(max, Math.max(180, rect.right - ev.clientX))));
    };
    const onUp = () => {
      setMapResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const layout = sessions[0]?.layout ?? null;

  function exportStem() {
    const s = sessions[0];
    const track = (s?.layout?.track_name || "track").replace(/\s+/g, "_");
    const date = (s?.started_at || "").slice(0, 10);
    const lapPart = selected
      .map((id) => {
        const l = laps.find((x) => x.id === id);
        return l ? `L${l.number}` : "";
      })
      .filter(Boolean)
      .slice(0, 8)
      .join("-");
    return [track, date, lapPart].filter(Boolean).join("_");
  }

  async function doExport(kind: "png" | "csv" | "original", sessionId?: number) {
    setExportErr("");
    setExportOpen(false);
    const stem = exportStem();
    try {
      if (kind === "png") {
        const label = TAB_LABEL[tab] || tab;
        const title = `${sessions[0]?.layout?.track_name || "Track"} · ${label} · ${stem.replace(/_/g, " ")}`;
        const ok = exportViewPng(`${stem}_${tab}.png`, title);
        if (!ok) setExportErr("Nothing to capture on this tab. Use Overlay, Splits, Histogram, AFR, or Report.");
        return;
      }
      if (kind === "csv") {
        if (!selected.length) throw new Error("Select laps first");
        await api.exportLapsCsv(selected, `${stem}_laps.csv`);
        return;
      }
      if (sessionId != null) {
        const s = sessions.find((x) => x.id === sessionId);
        const name = s?.filename?.replace(/\.csv$/i, "") || `session-${sessionId}`;
        await api.originalCsv(sessionId, `${name}.csv`);
      }
    } catch (e) {
      setExportErr(String(e instanceof Error ? e.message : e));
    }
  }

  const headerSlot = typeof document !== "undefined" ? document.getElementById("analysis-header-slot") : null;

  return (
    <UnitPrefContext.Provider value={unitPref}>
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {headerSlot &&
        createPortal(
          <>
            <button
              className="ghost"
              type="button"
              onClick={resetAnalysisSettings}
              title="Default channels, map, scales, and gates"
            >
              Reset view
            </button>
            <div className="export-wrap">
              <button className="ghost" type="button" onClick={() => setExportOpen((o) => !o)}>
                Export
              </button>
              {exportOpen && (
                <div className="export-pop">
                  <button type="button" onClick={() => doExport("png")}>
                    PNG of this view
                  </button>
                  <button type="button" disabled={!selected.length} onClick={() => doExport("csv")}>
                    CSV of selected laps
                  </button>
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      disabled={s.has_original === false}
                      onClick={() => doExport("original", s.id)}
                    >
                      Original CSV · {s.filename.replace(/\.csv$/i, "")}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>,
          headerSlot,
        )}
      <div className="topbar" style={{ borderTop: "1px solid var(--line)" }}>
        <div className="toolbar-inline">
          {sessions.map((s) => (
            <span className="pill" key={s.id}>
              {s.layout?.track_name || "Session"} · {s.filename.replace(/\.csv$/i, "")}
            </span>
          ))}
        </div>
        <nav className="tabs">
          {(["traces", "splits", "histogram", "afr", "report", "track", "coach"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </nav>
      </div>
      {(err || exportErr) && <div className="err" style={{ padding: 8 }}>{err || exportErr}</div>}
      {tab === "traces" && <SetupCompare sessions={sessions} />}
      {tab === "traces" && <MechanicalStrip lapIds={selected} />}
      {(tab === "traces" || tab === "histogram" || tab === "afr" || tab === "report") && (
        <GateBar
          preset={gatePreset}
          gates={gates}
          channels={listChannels}
          onPreset={setGatePreset}
          onGates={setGates}
          unitPref={unitPref}
          onUnitPref={applyUnitPref}
        />
      )}
      {tab === "traces" && (
        <div
          className={`workspace${mapResizing ? " resizing" : ""}`}
          ref={workspaceRef}
          style={{ ["--map-w" as string]: `${mapWidth}px` }}
        >
          <aside className="panel laps">
            <h3>Laps</h3>
            <div className="body">
              {laps.map((l) => {
                const on = selected.includes(l.id);
                const d = refId && l.id !== refId ? l.time_ms - (laps.find((x) => x.id === refId)?.time_ms || 0) : 0;
                return (
                  <div key={l.id} className="lap-row" onClick={() => toggleLap(l.id)} style={{ opacity: on || l.kind !== "valid" ? 1 : 0.7 }}>
                    <input type="checkbox" checked={on} readOnly />
                    <span className="dot" style={{ background: on ? colorFor(l.id) : "var(--line)" }} />
                    <span>
                      L{l.number}
                      {sessions.length > 1 && l.session_id != null && (
                        <span className="muted"> · {sessionTag(l.session_id)}</span>
                      )}{" "}
                      <select
                        className="kind-select lap-kind"
                        value={l.kind}
                        title="Flying laps count toward best and the coach. Out, in, pit, and invalid stay on the list."
                        onClick={(e) => e.stopPropagation()}
                        onChange={async (e) => {
                          e.stopPropagation();
                          const kind = e.target.value;
                          try {
                            await api.patchLap(l.id, kind);
                            const fresh = await api.session(l.session_id);
                            setSessions((ss) => ss.map((x) => (x.id === fresh.id ? fresh : x)));
                          } catch (ex: any) {
                            setErr(ex.message || String(ex));
                          }
                        }}
                      >
                        <option value="valid">flying</option>
                        <option value="out">out</option>
                        <option value="in">in</option>
                        <option value="pit">pit</option>
                        <option value="invalid">invalid</option>
                      </select>
                      {l.is_best && <span className="pill best">best</span>}
                      {on && refId === l.id && <span className="pill best">baseline</span>}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {fmtLap(l.time_ms)}{" "}
                        {on && refId && l.id !== refId && (
                          <span className={d <= 0 ? "delta-ahead" : "delta-behind"}>{fmtDelta(d)}</span>
                        )}
                      </div>
                    </span>
                  </div>
                );
              })}
              <h3 style={{ marginTop: 12 }}>Channels</h3>
              <input className="search" placeholder="Filter channels…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <ChannelList
                channels={listChannels}
                plotted={plotKeys}
                search={search}
                cursorVals={cursorVals}
                traces={traces}
                scales={chScale}
                onToggle={toggleCh}
                onReorder={reorderPlotted}
                onScale={setChannelScale}
              />
              <MathChannels math={math} onChange={setMath} />
            </div>
          </aside>
          <section className="panel traces">
            <h3>
              Overlay vs distance
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>aligned to baseline sectors</span>
              <span className="toolbar-inline">
                <span className="muted">
                  {markA != null && markB != null
                    ? `A ${fmtNum(markA, 0)} m → B ${fmtNum(markB, 0)} m · Δ ${fmtNum(Math.abs(markB - markA), 0)} m`
                    : markA != null
                      ? `A ${fmtNum(markA, 0)} m · click B · shift-click moves A`
                      : "click A · click B · drag to zoom"}
                </span>
                {!!(abData?.laps || []).length && (
                  <span className="ab-head-times">
                    {(abData.laps as any[]).map((r: any) => (
                      <span key={r.lap_id} style={{ color: colorFor(r.lap_id) }}>
                        L{laps.find((l) => l.id === r.lap_id)?.number ?? r.number}{" "}
                        {r.delta_s == null ? "—" : `${Number(r.delta_s).toFixed(3)}s`}
                      </span>
                    ))}
                  </span>
                )}
                {markA != null && (
                  <button className="ghost" onClick={unpin} title="Escape or right-click also clears">
                    Clear A/B
                  </button>
                )}
                {xRange && (
                  <button className="ghost" onClick={() => { setXRange(null); setDragRange(null); }}>
                    Reset zoom
                  </button>
                )}
              </span>
            </h3>
            <TraceStack
              traces={traces}
              plotted={plotKeys}
              channels={channels}
              scales={chScale}
              colorFor={colorFor}
              cursorDist={cursorDist}
              pinned={false}
              markA={markA}
              markB={markB}
              xRange={xRange}
              onPin={pinAt}
              onUnpin={unpin}
              onZoom={zoomTo}
              onDragRange={setDragRange}
              onHover={reportHover}
            />
            {abData ? (
              <AbStrip data={abData} laps={laps} colorFor={colorFor} channels={channels} plotted={plotKeys} preview={markB == null} />
            ) : markA != null && markB != null ? (
              <div className="cursor-strip muted">Measuring A–B window…</div>
            ) : (
              <CursorStrip cursor={cursorVals} selected={selected} colorFor={colorFor} channels={channels} plotted={plotKeys} />
            )}
          </section>
          <div className="overlay-side">
            <div
              className={`col-resizer${mapResizing ? " on" : ""}`}
              onPointerDown={startMapResize}
              title="Drag to resize map"
            />
            <section className="panel map">
              <h3>
                Track map
                <span className="toolbar-inline">
                  <span className="muted">Color</span>
                  <select
                    className="kind-select"
                    value={mapColor}
                    onChange={(e) => setMapColorPersist(e.target.value)}
                    title="Color the GPS line by a channel (shared scale across selected laps)"
                  >
                    {MAP_COLOR_OPTS.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </span>
              </h3>
              <div className="map-body">
                <TrackMap
                  data={mapData}
                  layout={layout}
                  selected={selected}
                  colorFor={colorFor}
                  colorBy={mapColor === "lap" ? null : mapColor}
                  cursorDist={null}
                  cursorLiveRef={mapCursorRef}
                  onCursor={pinAt}
                  onUnpin={unpin}
                  highlightRange={highlightRange}
                  zoomRange={xRange}
                  markA={markA}
                  markB={markB}
                  turns={turns}
                />
              </div>
            </section>
            <section className="panel scatter">
              <OverlayScatter
                selected={selected}
                channels={channels}
                colorFor={colorFor}
                cursorDist={null}
                cursorLiveRef={scatterCursorRef}
                xRange={xRange}
                gates={encodeGates(gates)}
                markA={markA}
                markB={markB}
                onUnpin={unpin}
                refId={refId}
              />
            </section>
          </div>
          <section className="panel story" data-export-root>
            <h3>
              Time gained / lost
              <span className="muted">
                {refId
                  ? `vs L${laps.find((l) => l.id === refId)?.number ?? "?"} ${fmtLap(laps.find((l) => l.id === refId)?.time_ms)} (fastest selected)`
                  : "select laps"}
              </span>
            </h3>
            <TurnRail turns={turns} onZoom={zoomTo} />
            <DeltaChart
              delta={delta}
              refId={refId}
              colorFor={colorFor}
              cursorDist={cursorDist}
              pinned={false}
              markA={markA}
              markB={markB}
              xRange={xRange}
              onPin={pinAt}
              onUnpin={unpin}
              onZoom={zoomTo}
              onDragRange={setDragRange}
              onHover={reportHover}
              laps={laps}
            />
          </section>
        </div>
      )}
      {tab === "splits" && <SplitsTab selected={selected} laps={laps} colorFor={colorFor} channels={channels} />}
      {tab === "histogram" && (
        <HistTab
          selected={selected}
          channels={channels}
          colorFor={colorFor}
          laps={laps}
          xRange={xRange}
          gates={encodeGates(gates)}
          refId={refId}
        />
      )}
      {tab === "afr" && (
        <AfrMapTab
          selected={selected}
          laps={laps}
          colorFor={colorFor}
          refId={refId}
          xRange={xRange}
          gates={encodeGates(gates)}
        />
      )}
      {tab === "report" && <ReportTab selected={selected} channels={channels} gates={encodeGates(gates)} />}
      {tab === "coach" && (
        <CoachTab
          selected={selected}
          laps={laps}
          sessions={sessions}
          colorFor={colorFor}
          view={{ mapColor, gatePreset, gates, plotted }}
          onPatchSession={async (id, body) => {
            const s = await api.patchSession(id, body);
            setSessions((ss) => ss.map((x) => (x.id === id ? { ...x, notes: s.notes, log_sheet: s.log_sheet, vehicle: s.vehicle } : x)));
          }}
        />
      )}
      {tab === "track" && layout && sessions[0] && (
        <TrackTab
          layout={layout}
          sessions={sessions}
          mapData={mapData}
          colorFor={colorFor}
          onSaved={async () => {
            const keep = new Set(laps.filter((l) => selected.includes(l.id)).map((l) => l.number));
            const ss = await Promise.all(sessions.map((s) => api.session(s.id)));
            setSessions(ss);
            const next = ss.flatMap((s) => (s.laps || []).filter((l) => keep.has(l.number)).map((l) => l.id));
            if (next.length) setSelected(next);
          }}
        />
      )}
    </div>
    </UnitPrefContext.Provider>
  );
}

function ChannelList({
  channels,
  plotted,
  search,
  cursorVals,
  traces,
  scales,
  onToggle,
  onReorder,
  onScale,
}: {
  channels: Channel[];
  plotted: string[];
  search: string;
  cursorVals: any;
  traces: any[];
  scales: Record<string, ChScale>;
  onToggle: (key: string) => void;
  onReorder: (from: string, to: string, after: boolean) => void;
  onScale: (key: string, patch: Partial<ChScale>) => void;
}) {
  const dragKey = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(null);
  const pref = useUnitPref();
  const q = search.trim().toLowerCase();
  const match = (c: Channel) => !q || (c.name + c.key).toLowerCase().includes(q);
  const selected = plotted.map((k) => channels.find((c) => c.key === k)).filter((c): c is Channel => !!c && match(c));
  const rest = channels.filter((c) => !plotted.includes(c.key) && match(c)).sort((a, b) => a.name.localeCompare(b.name));

  function row(c: Channel, on: boolean) {
    const shown = displayChannel(c, pref);
    const raw = cursorVals?.values?.[0]?.[c.key];
    const v = convertMaybe(raw, c.unit, shown.unit);
    const dropping = drop?.key === c.key;
    const sc = scales[c.key] || { min: null, max: null };
    const dataRangeRaw = channelDataRange(traces, c.key);
    const dataRange = dataRangeRaw
      ? {
          min: convertValue(dataRangeRaw.min, c.unit, shown.unit),
          max: convertValue(dataRangeRaw.max, c.unit, shown.unit),
        }
      : null;
    return (
      <div
        key={c.key}
        className={`ch-row ${on ? "on" : "off"}${dropping ? (drop?.after ? " drop-after" : " drop-before") : ""}`}
        onClick={() => onToggle(c.key)}
        onDragOver={
          on
            ? (e: DragEvent) => {
                if (!dragKey.current || dragKey.current === c.key) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setDrop({ key: c.key, after: e.clientY > rect.top + rect.height / 2 });
              }
            : undefined
        }
        onDrop={
          on
            ? (e: DragEvent) => {
                e.preventDefault();
                const from = dragKey.current;
                const after = drop?.key === c.key ? drop.after : e.clientY > (e.currentTarget as HTMLElement).getBoundingClientRect().top + (e.currentTarget as HTMLElement).getBoundingClientRect().height / 2;
                dragKey.current = null;
                setDrop(null);
                if (from) onReorder(from, c.key, after);
              }
            : undefined
        }
        onDragLeave={
          on
            ? (e: DragEvent) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrop((d) => (d?.key === c.key ? null : d));
              }
            : undefined
        }
      >
        <span
          className="grip"
          title={on ? "Drag to reorder plots" : undefined}
          draggable={on}
          onClick={(e) => e.stopPropagation()}
          onDragStart={
            on
              ? (e: DragEvent) => {
                  dragKey.current = c.key;
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", c.key);
                }
              : undefined
          }
          onDragEnd={() => {
            dragKey.current = null;
            setDrop(null);
          }}
        >
          ⋮⋮
        </span>
        <input type="checkbox" checked={on} readOnly />
        <span className="dot" style={{ background: on ? "var(--blue)" : "var(--line)" }} />
        <span>
          {shown.name}
          <div className="muted" style={{ fontSize: 11 }}>{shown.unit || c.key}</div>
          {on && (
            <div className="ch-scale" onClick={(e) => e.stopPropagation()}>
              <input
                type="number"
                step="any"
                title="Y-axis min (blank = data min)"
                placeholder={dataRange ? String(Number(dataRange.min.toPrecision(4))) : "min"}
                value={sc.min ?? ""}
                onChange={(e) => {
                  const t = e.target.value;
                  onScale(c.key, { min: t === "" ? null : Number(t) });
                }}
              />
              <span className="muted">–</span>
              <input
                type="number"
                step="any"
                title="Y-axis max (blank = data max). Example: throttle that peaks at 75, set max 75 so WOT fills the plot."
                placeholder={dataRange ? String(Number(dataRange.max.toPrecision(4))) : "max"}
                value={sc.max ?? ""}
                onChange={(e) => {
                  const t = e.target.value;
                  onScale(c.key, { max: t === "" ? null : Number(t) });
                }}
              />
            </div>
          )}
        </span>
        <span className="val">{on && v != null ? fmtNum(v, Math.abs(v) > 20 ? 0 : 2) : ""}</span>
      </div>
    );
  }

  if (!selected.length && !rest.length) {
    return <div className="muted">No channels{q ? " match" : ""}.</div>;
  }
  return (
    <>
      {selected.map((c) => row(c, true))}
      {selected.length > 0 && rest.length > 0 && <div className="ch-split" />}
      {rest.map((c) => row(c, false))}
    </>
  );
}

function CursorStrip({
  cursor,
  selected,
  colorFor,
  channels,
  plotted,
}: {
  cursor: any;
  selected: number[];
  colorFor: (id: number) => string;
  channels: Channel[];
  plotted: string[];
}) {
  const pref = useUnitPref();
  if (!cursor?.values?.length) return null;
  const keys = plotted.slice(0, 8);
  return (
    <div className="cursor-strip">
      {cursor.values.map((v: any) => (
        <div key={v.lap_id}>
          <span className="dot" style={{ background: colorFor(v.lap_id), display: "inline-block", marginRight: 6 }} />
          {keys.map((k) => {
            const meta = channels.find((c) => c.key === k);
            const shown = meta ? displayChannel(meta, pref) : undefined;
            const val = convertMaybe(v[k], meta?.unit || "", shown?.unit || "");
            return (
              <span key={k} style={{ marginRight: 10 }}>
                <b>{shown?.name || meta?.name || k}</b>
                {val == null ? "—" : fmtNum(val, 1)}
              </span>
            );
          })}
          {v.t_ms != null && (
            <span>
              <b>t</b>
              {fmtLap(v.t_ms)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function AbStrip({
  data,
  laps,
  colorFor,
  channels,
  plotted,
  preview,
}: {
  data: any;
  laps: Lap[];
  colorFor: (id: number) => string;
  channels: Channel[];
  plotted: string[];
  preview?: boolean;
}) {
  const pref = useUnitPref();
  const keys = plotted.filter((k) => k !== "delta_t").slice(0, 5);
  const rows = data?.laps || [];
  if (!rows.length) return null;
  return (
    <div className="cursor-strip ab-strip">
      <div className="ab-head">
        <span className="ab-a">A {fmtNum(data.dist_a, 0)} m</span>
        <span className="muted">→</span>
        <span className="ab-b">B {fmtNum(data.dist_b, 0)} m</span>
        <span className="muted">Δ {fmtNum(data.delta_m, 0)} m{preview ? " · preview" : ""}</span>
      </div>
      {rows.map((r: any) => {
        const lap = laps.find((l) => l.id === r.lap_id);
        return (
          <div key={r.lap_id}>
            <span className="dot" style={{ background: colorFor(r.lap_id), display: "inline-block", marginRight: 6 }} />
            <span style={{ marginRight: 10 }}>
              L{lap?.number ?? r.number}{" "}
              <b>Δt</b> {r.delta_s == null ? "—" : `${r.delta_s.toFixed(3)} s`}
            </span>
            {keys.map((k) => {
              const meta = channels.find((c) => c.key === k);
              const shown = meta ? displayChannel(meta, pref) : undefined;
              const s = r.channels?.[k];
              if (!s) return null;
              const mn = convertMaybe(s.min, meta?.unit || "", shown?.unit || "");
              const mx = convertMaybe(s.max, meta?.unit || "", shown?.unit || "");
              const avg = convertMaybe(s.avg, meta?.unit || "", shown?.unit || "");
              return (
                <span key={k} style={{ marginRight: 10 }}>
                  <b>{shown?.name || meta?.name || k}</b>
                  {mn == null ? "—" : `${fmtNum(mn, 1)}–${fmtNum(mx, 1)}`}
                  <span className="muted"> avg {avg == null ? "—" : fmtNum(avg, 1)}</span>
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function bindPlotInput(
  u: uPlot,
  handlers: {
    onPin: (dist: number, shift?: boolean) => void;
    onUnpin: () => void;
    onZoom: (range: [number, number]) => void;
    onDragRange: (range: [number, number] | null) => void;
  }
) {
  const over = u.over;
  const root = u.root;
  const drag = { active: false, moved: false, x: 0, y: 0 };
  const down = (e: MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      handlers.onUnpin();
      return;
    }
    if (e.button !== 0) return;
    drag.active = true;
    drag.moved = false;
    drag.x = e.clientX;
    drag.y = e.clientY;
  };
  const move = (e: MouseEvent) => {
    if (!drag.active) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) drag.moved = true;
    if (!drag.moved) return;
    const rect = over.getBoundingClientRect();
    const x0 = drag.x - rect.left;
    const x1 = e.clientX - rect.left;
    const left = Math.max(0, Math.min(x0, x1));
    const right = Math.min(rect.width, Math.max(x0, x1));
    u.setSelect({ left, top: 0, width: Math.max(0, right - left), height: rect.height }, false);
    const a = u.posToVal(left, "x");
    const b = u.posToVal(right, "x");
    handlers.onDragRange([Math.min(a, b), Math.max(a, b)]);
  };
  const up = (e: MouseEvent) => {
    if (e.button !== 0 || !drag.active) return;
    drag.active = false;
    if (drag.moved) {
      const left = u.select.left;
      const width = u.select.width;
      const a = u.posToVal(left, "x");
      const b = u.posToVal(left + width, "x");
      u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
      handlers.onDragRange(null);
      if (width > 10) handlers.onZoom([Math.min(a, b), Math.max(a, b)]);
      return;
    }
    handlers.onDragRange(null);
    const left = u.cursor.left;
    if (left == null || left < 0) return;
    handlers.onPin(u.posToVal(left, "x"), e.shiftKey);
  };
  const ctx = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.onUnpin();
  };
  over.addEventListener("mousedown", down);
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  root.addEventListener("contextmenu", ctx, true);
  over.addEventListener("contextmenu", ctx, true);
  return () => {
    over.removeEventListener("mousedown", down);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    root.removeEventListener("contextmenu", ctx, true);
    over.removeEventListener("contextmenu", ctx, true);
  };
}

function applyXRange(u: uPlot, xRange: [number, number] | null, xs: number[]) {
  if (!xs.length) return;
  if (xRange) u.setScale("x", { min: xRange[0], max: xRange[1] });
  else u.setScale("x", { min: xs[0], max: xs[xs.length - 1] });
  u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
}

function formatPointValue(y: number, seconds = false): string {
  if (seconds) {
    const sign = y > 0 ? "+" : y < 0 ? "−" : "";
    return `${sign}${Math.abs(y).toFixed(3)}s`;
  }
  const a = Math.abs(y);
  if (a >= 100) return y.toFixed(0);
  if (a >= 10) return y.toFixed(1);
  return y.toFixed(2);
}

function isLocalHover(u: uPlot): boolean {
  const e = u.cursor.event;
  if (!e || typeof e !== "object" || !("target" in e) || !e.target) return false;
  return u.over.contains(e.target as Node);
}

function seriesHasCursorPt(s: uPlot.Series): boolean {
  return s.show !== false && (s.width ?? 1) > 0;
}

function overlayCursor(): uPlot.Cursor {
  return {
    x: true,
    y: true,
    points: {
      size: 8,
      width: 2,
      show: ((u, si) => {
        if (si === 0 || !seriesHasCursorPt(u.series[si])) return null;
        const pt = document.createElement("div");
        pt.style.width = "8px";
        pt.style.height = "8px";
        pt.style.marginLeft = "-4px";
        pt.style.marginTop = "-4px";
        pt.style.borderWidth = "2px";
        return pt;
      }) as uPlot.Cursor.Points.Show,
    },
    sync: { key: "overlay", scales: ["x", null] },
    drag: { x: false, y: false, setScale: false },
  };
}

function seriesStroke(s: uPlot.Series): string {
  const anyS = s as { _stroke?: unknown; stroke?: unknown };
  if (typeof anyS._stroke === "string" && anyS._stroke) return anyS._stroke;
  if (typeof anyS.stroke === "string" && anyS.stroke) return anyS.stroke;
  return "#8b949e";
}

function labelSeriesDots(u: uPlot, seconds: boolean, show: boolean) {
  const leftover = u.over.querySelector(":scope > .crosshair-val");
  leftover?.remove();
  const pts = [...u.over.querySelectorAll(":scope > .u-cursor-pt")] as HTMLElement[];
  const idx = u.cursor.idx;
  let pti = 0;
  const placed: { el: HTMLElement; y: number }[] = [];
  for (let si = 1; si < u.series.length; si++) {
    if (!seriesHasCursorPt(u.series[si])) continue;
    const el = pts[pti++];
    if (!el) continue;
    if (!show || idx == null || idx < 0) {
      el.removeAttribute("data-val");
      continue;
    }
    const y = u.data[si]?.[idx];
    if (y == null || Number.isNaN(Number(y))) {
      el.removeAttribute("data-val");
      continue;
    }
    el.setAttribute("data-val", formatPointValue(Number(y), seconds));
    el.style.setProperty("--val-border", seriesStroke(u.series[si]));
    placed.push({ el, y: u.valToPos(Number(y), "y") });
  }
  const left = u.cursor.left ?? 0;
  const flip = left > (u.over.clientWidth || 200) - 72;
  const dx = flip ? "calc(-100% - 14px)" : "14px";
  if (placed.length < 2) {
    for (const p of placed) {
      p.el.style.setProperty("--val-dx", dx);
      p.el.style.setProperty("--val-dy", "0px");
    }
    return;
  }
  placed.sort((a, b) => a.y - b.y);
  const gap = 16;
  const pos = placed.map((p) => p.y);
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] < pos[i - 1] + gap) pos[i] = pos[i - 1] + gap;
  }
  const h = u.over.clientHeight || 80;
  const overflow = pos[pos.length - 1] - (h - 8);
  if (overflow > 0) {
    for (let i = 0; i < pos.length; i++) pos[i] -= overflow;
  }
  if (pos[0] < 8) {
    const shift = 8 - pos[0];
    for (let i = 0; i < pos.length; i++) pos[i] += shift;
  }
  for (let i = 0; i < placed.length; i++) {
    placed[i].el.style.setProperty("--val-dx", dx);
    placed[i].el.style.setProperty("--val-dy", `${pos[i] - placed[i].y}px`);
  }
}

function onPlotCursor(u: uPlot, seconds: boolean, onHover: (d: number | null) => void) {
  const local = isLocalHover(u);
  labelSeriesDots(u, seconds, local);
  const yEl = u.over.querySelector(":scope > .u-cursor-y") as HTMLElement | null;
  if (yEl) yEl.style.visibility = local ? "visible" : "hidden";
  if (!local) return;
  const left = u.cursor.left ?? -10;
  onHover(left < 0 ? null : u.posToVal(left, "x"));
}

function applyPinnedCursor(u: uPlot, dist: number, pinned: boolean) {
  if (!u.data[0]?.length) return;
  if (!pinned) {
    (u.cursor as { _lock?: boolean })._lock = false;
    return;
  }
  const xs = u.data[0] as number[];
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - dist);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const top = u.cursor.top != null && u.cursor.top >= 0 ? u.cursor.top : u.valToPos(u.data[1]?.[best] ?? 0, "y");
  (u.cursor as { _lock?: boolean })._lock = true;
  u.setCursor({ left: u.valToPos(xs[best], "x"), top });
}

function applyAbMarks(u: uPlot, a: number | null, b: number | null) {
  const over = u.over;
  if (!over) return;
  over.querySelectorAll(":scope > .ab-mark, :scope > .ab-span").forEach((el) => el.remove());
  if (!u.data[0]?.length) return;
  const w = over.clientWidth || 0;
  const addMark = (dist: number, cls: string, label: string) => {
    const left = u.valToPos(dist, "x");
    if (left < -2 || left > w + 2) return;
    const el = document.createElement("div");
    el.className = `ab-mark ${cls}`;
    el.innerHTML = `<span>${label}</span>`;
    el.style.left = `${left}px`;
    over.appendChild(el);
  };
  if (a != null && b != null && Math.abs(b - a) >= 2) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const left = u.valToPos(lo, "x");
    const right = u.valToPos(hi, "x");
    const span = document.createElement("div");
    span.className = "ab-span";
    span.style.left = `${Math.min(left, right)}px`;
    span.style.width = `${Math.max(0, Math.abs(right - left))}px`;
    over.insertBefore(span, over.firstChild);
  }
  if (a != null) addMark(a, "ab-mark-a", "A");
  if (b != null) addMark(b, "ab-mark-b", "B");
}

function TraceStack({
  traces,
  plotted,
  channels,
  scales,
  colorFor,
  cursorDist,
  pinned,
  markA,
  markB,
  xRange,
  onPin,
  onUnpin,
  onZoom,
  onDragRange,
  onHover,
}: {
  traces: any[];
  plotted: string[];
  channels: Channel[];
  scales: Record<string, ChScale>;
  colorFor: (id: number) => string;
  cursorDist: number;
  pinned: boolean;
  markA: number | null;
  markB: number | null;
  xRange: [number, number] | null;
  onPin: (d: number, shift?: boolean) => void;
  onUnpin: () => void;
  onZoom: (range: [number, number]) => void;
  onDragRange: (range: [number, number] | null) => void;
  onHover: (d: number | null) => void;
}) {
  const pref = useUnitPref();
  const have = new Set(channels.map((c) => c.key));
  const keys = plotted.filter(
    (k) => have.has(k) && traces.some((t) => (t.series?.[k]?.x?.length || 0) > 1)
  );
  return (
    <div className="plot-stack" data-export-root>
      {keys.map((key) => {
        const ch = channels.find((c) => c.key === key);
        const shown = ch ? displayChannel(ch, pref) : undefined;
        const native = ch?.unit || "";
        const disp = shown?.unit || native;
        const converted = native === disp
          ? traces
          : traces.map((t) => {
              const ser = t.series?.[key];
              if (!ser) return t;
              return { ...t, series: { ...t.series, [key]: { ...ser, y: convertY(ser.y, native, disp) } } };
            });
        return (
        <div className="plot-row" key={key}>
          <div className="ylabel">{channelAxisLabel(shown || ch, key)}</div>
          <UPlotRow
            seriesKey={key}
            traces={converted}
            colorFor={colorFor}
            cursorDist={cursorDist}
            pinned={pinned}
            markA={markA}
            markB={markB}
            xRange={xRange}
            yMin={scales[key]?.min ?? null}
            yMax={scales[key]?.max ?? null}
            onPin={onPin}
            onUnpin={onUnpin}
            onZoom={onZoom}
            onDragRange={onDragRange}
            onHover={onHover}
          />
        </div>
        );
      })}
      {!keys.length && <div className="muted" style={{ padding: 12 }}>Check laps and channels in the list to plot them.</div>}
    </div>
  );
}

function applyYScale(u: uPlot, yMin: number | null, yMax: number | null) {
  let dmin = Infinity;
  let dmax = -Infinity;
  for (let i = 1; i < u.data.length; i++) {
    const col = u.data[i] as (number | null)[];
    for (const v of col) {
      if (v == null || Number.isNaN(Number(v))) continue;
      const n = Number(v);
      if (n < dmin) dmin = n;
      if (n > dmax) dmax = n;
    }
  }
  const min = yMin ?? (Number.isFinite(dmin) ? dmin : 0);
  const max = yMax ?? (Number.isFinite(dmax) ? dmax : 1);
  u.setScale("y", { min, max: max === min ? min + 1 : max });
}

function UPlotRow({
  seriesKey,
  traces,
  colorFor,
  cursorDist,
  pinned,
  markA,
  markB,
  xRange,
  yMin,
  yMax,
  onPin,
  onUnpin,
  onZoom,
  onDragRange,
  onHover,
}: {
  seriesKey: string;
  traces: any[];
  colorFor: (id: number) => string;
  cursorDist: number;
  pinned: boolean;
  markA: number | null;
  markB: number | null;
  xRange: [number, number] | null;
  yMin: number | null;
  yMax: number | null;
  onPin: (d: number, shift?: boolean) => void;
  onUnpin: () => void;
  onZoom: (range: [number, number]) => void;
  onDragRange: (range: [number, number] | null) => void;
  onHover: (d: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const xsRef = useRef<number[]>([]);
  const yRef = useRef({ yMin, yMax });
  yRef.current = { yMin, yMax };
  const handlers = useRef({ onPin, onUnpin, onZoom, onDragRange, onHover });
  handlers.current = { onPin, onUnpin, onZoom, onDragRange, onHover };
  const marksRef = useRef({ a: markA, b: markB });
  marksRef.current = { a: markA, b: markB };
  const theme = useTheme();

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const pt = plotTheme();
    const series: uPlot.Series[] = [{ label: "dist" }];
    const cols: number[][] = [];
    let x: number[] = [];
    for (const t of traces) {
      const ser = t.series?.[seriesKey];
      if (!ser) continue;
      if (!x.length) x = ser.x;
      series.push({
        label: `L${t.number}`,
        stroke: colorFor(t.lap_id),
        width: 1.4,
        points: { show: false },
      });
      cols.push(resampleTo(ser.x, ser.y, x));
    }
    xsRef.current = x;
    const data: uPlot.AlignedData = [x, ...cols];
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(el.clientHeight || 90, 70),
      pxAlign: 0,
      cursor: overlayCursor(),
      select: { show: true },
      legend: { show: false },
      scales: {
        x: xRange ? { time: false, min: xRange[0], max: xRange[1] } : { time: false },
        y: { auto: false },
      },
      axes: [
        {
          stroke: pt.axis,
          grid: { stroke: pt.grid },
          ticks: { stroke: pt.tick },
          font: "11px sans-serif",
          size: 8,
          values: () => [],
        },
        {
          stroke: pt.axis,
          grid: { stroke: pt.grid },
          ticks: { stroke: pt.tick },
          font: "11px sans-serif",
          size: 46,
        },
      ],
      series,
      hooks: {
        setCursor: [(u) => onPlotCursor(u, false, handlers.current.onHover)],
        setScale: [(u) => applyAbMarks(u, marksRef.current.a, marksRef.current.b)],
      },
    };
    plot.current?.destroy();
    const u = new uPlot(opts, data, el);
    plot.current = u;
    applyYScale(u, yRef.current.yMin, yRef.current.yMax);
    const unbind = bindPlotInput(u, {
      onPin: (d, shift) => handlers.current.onPin(d, shift),
      onUnpin: () => handlers.current.onUnpin(),
      onZoom: (r) => handlers.current.onZoom(r),
      onDragRange: (r) => handlers.current.onDragRange(r),
    });
    const ro = new ResizeObserver(() => {
      if (!plot.current || !el) return;
      plot.current.setSize({ width: el.clientWidth, height: Math.max(el.clientHeight, 70) });
    });
    ro.observe(el);
    return () => {
      unbind();
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [traces, seriesKey, theme]);

  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    applyXRange(u, xRange, xsRef.current);
  }, [xRange]);

  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    applyYScale(u, yMin, yMax);
  }, [yMin, yMax]);

  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    applyPinnedCursor(u, cursorDist, pinned);
    applyAbMarks(u, markA, markB);
  }, [cursorDist, pinned, markA, markB, xRange]);

  return <div ref={ref} style={{ height: "100%", width: "100%" }} />;
}

function resampleTo(x: number[], y: (number | null)[], grid: number[]): number[] {
  if (!x.length || !grid.length) return grid.map(() => NaN);
  const out = new Array(grid.length);
  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i];
    while (j < x.length - 2 && x[j + 1] < g) j++;
    const x0 = x[j];
    const x1 = x[Math.min(j + 1, x.length - 1)];
    const y0 = y[j];
    const y1 = y[Math.min(j + 1, y.length - 1)];
    if (y0 == null || y1 == null || x1 === x0) {
      out[i] = Number(y0 ?? y1 ?? NaN);
    } else {
      const t = (g - x0) / (x1 - x0);
      out[i] = Number(y0) + t * (Number(y1) - Number(y0));
    }
  }
  return out;
}

const EARTH_M = 6371000;

function destPoint(lat: number, lon: number, bearing: number, distM: number) {
  const br = (bearing * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const d = distM / EARTH_M;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 =
    lon1 +
    Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
}

function headingBetween(lat1: number, lon1: number, lat2: number, lon2: number) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const x = Math.sin(dl) * Math.cos(p2);
  const y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

function proposeEndsFromTraces(data: any[]): { start: Gate; finish: Gate } | null {
  const tr = data[0];
  if (!tr?.lat?.length) return null;
  const pts: { i: number; lat: number; lon: number }[] = [];
  for (let i = 0; i < tr.lat.length; i++) {
    if (tr.lat[i] && tr.lon[i]) pts.push({ i, lat: tr.lat[i], lon: tr.lon[i] });
  }
  if (pts.length < 8) return null;
  let i0 = pts[0].i;
  let i1 = pts[pts.length - 1].i;
  const dist = tr.dist;
  if (dist?.length) {
    const d0 = Number(dist[pts[0].i]) || 0;
    const d1 = Number(dist[pts[pts.length - 1].i]) || 0;
    const pad = Math.min(80, Math.max(0, d1 - d0) * 0.02);
    for (const p of pts) {
      if ((Number(dist[p.i]) || 0) >= d0 + pad) {
        i0 = p.i;
        break;
      }
    }
    for (let k = pts.length - 1; k >= 0; k--) {
      if ((Number(dist[pts[k].i]) || 0) <= d1 - pad) {
        i1 = pts[k].i;
        break;
      }
    }
  }
  const ahead = (i: number, n: number) => {
    const j = Math.min(Math.max(0, i + n), tr.lat.length - 1);
    if (tr.lat[j] && tr.lon[j] && j !== i) return { lat: tr.lat[j], lon: tr.lon[j] };
    const k = Math.min(Math.max(0, i - n), tr.lat.length - 1);
    return { lat: tr.lat[k], lon: tr.lon[k] };
  };
  const a2 = ahead(i0, 8);
  const b1 = ahead(i1, -8);
  return {
    start: gateFromPoint(tr.lat[i0], tr.lon[i0], headingBetween(tr.lat[i0], tr.lon[i0], a2.lat, a2.lon)),
    finish: gateFromPoint(tr.lat[i1], tr.lon[i1], headingBetween(b1.lat, b1.lon, tr.lat[i1], tr.lon[i1])),
  };
}

function gateFromPoint(lat: number, lon: number, heading: number, halfWidthM = 16): Gate {
  return {
    a: destPoint(lat, lon, heading + 90, halfWidthM),
    b: destPoint(lat, lon, heading - 90, halfWidthM),
    heading,
    lat,
    lon,
  };
}

function cleanGate(g: Gate, source = "user"): Gate {
  return {
    a: { lat: g.a.lat, lon: g.a.lon },
    b: { lat: g.b.lat, lon: g.b.lon },
    heading: g.heading,
    lat: g.lat,
    lon: g.lon,
    source,
  };
}

function gateMid(g: Gate): { lat: number; lon: number } {
  return {
    lat: g.lat ?? (g.a.lat + g.b.lat) / 2,
    lon: g.lon ?? (g.a.lon + g.b.lon) / 2,
  };
}

function distAtLatLon(data: any[], lat: number, lon: number): number {
  let best = 0;
  let bd = Infinity;
  for (const tr of data) {
    const n = tr.lat?.length || 0;
    for (let i = 0; i < n; i++) {
      if (!tr.lat[i] || !tr.lon[i]) continue;
      const d = Math.hypot(tr.lat[i] - lat, tr.lon[i] - lon);
      if (d >= bd) continue;
      bd = d;
      best = tr.dist?.[i] ?? 0;
    }
  }
  return best;
}

function pathLength(data: any[]): number {
  let m = 0;
  for (const tr of data) {
    const d = tr.dist;
    if (d?.length) m = Math.max(m, Number(d[d.length - 1]) || 0);
  }
  return m;
}

function sortSectors(data: any[], sectors: Gate[]): Gate[] {
  return [...sectors].sort((a, b) => {
    const ma = gateMid(a);
    const mb = gateMid(b);
    return distAtLatLon(data, ma.lat, ma.lon) - distAtLatLon(data, mb.lat, mb.lon);
  });
}

const MIN_SPLIT_M = 80;
const MAX_SPLITS = 7;

function splitTooClose(data: any[], g: Gate, others: Gate[]): boolean {
  const mid = gateMid(g);
  const d = distAtLatLon(data, mid.lat, mid.lon);
  const length = pathLength(data);
  if (d < MIN_SPLIT_M || (length > 0 && length - d < MIN_SPLIT_M)) return true;
  for (const o of others) {
    const om = gateMid(o);
    if (Math.abs(d - distAtLatLon(data, om.lat, om.lon)) < MIN_SPLIT_M) return true;
  }
  return false;
}

function equalSectorGates(data: any[], nSectors: number): Gate[] {
  const n = Math.max(2, Math.min(MAX_SPLITS + 1, Math.round(nSectors)));
  const length = pathLength(data);
  if (length < 200) return [];
  const out: Gate[] = [];
  for (let i = 1; i < n; i++) {
    const g = gateAtDist(data, (i / n) * length, 16);
    if (g) out.push(g);
  }
  return out;
}

function sampleTraceAtDist(tr: any, dist: number, spanM = 18): { lat: number; lon: number; heading: number } | null {
  const n = Math.min(tr.dist?.length || 0, tr.lat?.length || 0, tr.lon?.length || 0);
  if (n < 2) return null;
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < n; i++) {
    if (!tr.lat[i] || !tr.lon[i] || tr.dist[i] == null) continue;
    const d = Math.abs(tr.dist[i] - dist);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  if (best < 0) return null;
  let i0 = best;
  let i1 = best;
  while (i0 > 0 && tr.dist[best] - tr.dist[i0] < spanM) {
    if (tr.lat[i0 - 1] && tr.lon[i0 - 1]) i0--;
    else break;
  }
  while (i1 < n - 1 && tr.dist[i1] - tr.dist[best] < spanM) {
    if (tr.lat[i1 + 1] && tr.lon[i1 + 1]) i1++;
    else break;
  }
  if (i0 === i1) {
    i0 = Math.max(0, best - 4);
    i1 = Math.min(n - 1, best + 4);
  }
  while (i0 < i1 && (!tr.lat[i0] || !tr.lon[i0])) i0++;
  while (i1 > i0 && (!tr.lat[i1] || !tr.lon[i1])) i1--;
  let heading = 0;
  if (i0 !== i1 && tr.lat[i0] && tr.lon[i0] && tr.lat[i1] && tr.lon[i1]) {
    heading = headingBetween(tr.lat[i0], tr.lon[i0], tr.lat[i1], tr.lon[i1]);
  }
  return { lat: tr.lat[best], lon: tr.lon[best], heading };
}

function gateAtDist(data: any[], dist: number, halfWidthM = 28): Gate | null {
  const samples = [];
  for (const tr of data) {
    const s = sampleTraceAtDist(tr, dist);
    if (s) samples.push(s);
  }
  if (!samples.length) return null;
  let sin = 0;
  let cos = 0;
  let lat = 0;
  let lon = 0;
  for (const s of samples) {
    const r = (s.heading * Math.PI) / 180;
    sin += Math.sin(r);
    cos += Math.cos(r);
    lat += s.lat;
    lon += s.lon;
  }
  const heading = ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
  return gateFromPoint(lat / samples.length, lon / samples.length, heading, halfWidthM);
}

function snapToTraces(data: any[], lat: number, lon: number, fallbackHdg: number) {
  let bestLat = lat;
  let bestLon = lon;
  let bestHdg = fallbackHdg;
  let bd = Infinity;
  for (const tr of data) {
    const n = tr.lat?.length || 0;
    for (let i = 0; i < n; i++) {
      if (!tr.lat[i] || !tr.lon[i]) continue;
      const d = Math.hypot(tr.lat[i] - lat, tr.lon[i] - lon);
      if (d >= bd) continue;
      bd = d;
      bestLat = tr.lat[i];
      bestLon = tr.lon[i];
      const j = i < n - 1 ? i : Math.max(0, i - 1);
      const k = Math.min(j + 1, n - 1);
      if (tr.lat[j] && tr.lat[k] && (j !== k)) bestHdg = headingBetween(tr.lat[j], tr.lon[j], tr.lat[k], tr.lon[k]);
    }
  }
  return { lat: bestLat, lon: bestLon, heading: bestHdg };
}

function rainbowSegments(
  lat: number[],
  lon: number[],
  values: (number | null)[],
  vmin: number,
  vmax: number
): { color: string; pts: L.LatLngExpression[] }[] {
  const span = vmax - vmin || 1;
  const segs: { color: string; pts: L.LatLngExpression[] }[] = [];
  let curColor = "";
  let curPts: L.LatLngExpression[] = [];
  for (let i = 0; i < lat.length; i++) {
    if (!lat[i] || !lon[i]) continue;
    const v = values[i];
    const t = v == null || !Number.isFinite(v) ? null : (v - vmin) / span;
    const color = t == null ? "#8b949e" : heatColor(t);
    const pt: L.LatLngExpression = [lat[i], lon[i]];
    if (color !== curColor) {
      if (curPts.length >= 2) segs.push({ color: curColor, pts: curPts });
      curPts = curPts.length ? [curPts[curPts.length - 1], pt] : [pt];
      curColor = color;
    } else {
      curPts.push(pt);
    }
  }
  if (curPts.length >= 2) segs.push({ color: curColor, pts: curPts });
  return segs;
}

function TrackMap({
  data,
  layout,
  selected,
  colorFor,
  colorBy,
  cursorDist,
  cursorLiveRef,
  onCursor,
  onUnpin,
  highlightRange,
  zoomRange,
  markA,
  markB,
  turns,
  editGate,
  onEditGate,
  onEditFinish,
  placingKind,
  selectedSplit,
  onEditSectors,
  onSelectSplit,
  onPlace,
}: {
  data: any[];
  layout: Layout | null;
  selected: number[];
  colorFor: (id: number) => string;
  colorBy?: string | null;
  cursorDist: number | null;
  cursorLiveRef?: { current: (d: number | null) => void };
  onCursor: (d: number, shift?: boolean) => void;
  onUnpin?: () => void;
  highlightRange?: [number, number] | null;
  zoomRange?: [number, number] | null;
  markA?: number | null;
  markB?: number | null;
  turns?: { n: number; apex_m: number; name?: string | null }[];
  editGate?: Gate | null;
  onEditGate?: (g: Gate) => void;
  onEditFinish?: (g: Gate) => void;
  placingKind?: "split" | "start" | "finish" | null;
  selectedSplit?: number | null;
  onEditSectors?: (sectors: Gate[]) => void;
  onSelectSplit?: (i: number | null) => void;
  onPlace?: (g: Gate) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<L.Layer[]>([]);
  const gateLayers = useRef<L.Layer[]>([]);
  const sectorLayers = useRef<L.Layer[]>([]);
  const highlight = useRef<L.Layer[]>([]);
  const markers = useRef<Record<number, L.CircleMarker>>({});
  const canvasRenderer = useRef<L.Canvas | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const zoomRangeRef = useRef(zoomRange ?? null);
  zoomRangeRef.current = zoomRange ?? null;
  const editRef = useRef(onEditGate);
  editRef.current = onEditGate;
  const editFinishRef = useRef(onEditFinish);
  editFinishRef.current = onEditFinish;
  const editSectorsRef = useRef(onEditSectors);
  editSectorsRef.current = onEditSectors;
  const selectSplitRef = useRef(onSelectSplit);
  selectSplitRef.current = onSelectSplit;
  const placeRef = useRef(onPlace);
  placeRef.current = onPlace;
  const placingRef = useRef(placingKind || null);
  placingRef.current = placingKind || null;
  const [legend, setLegend] = useState<{ name: string; unit: string; min: number; max: number } | null>(null);
  const pref = useUnitPref();

  function fitMap(range: [number, number] | null) {
    const map = mapRef.current;
    const traces = dataRef.current || [];
    if (!map || !traces.length) return;
    const pts: L.LatLngTuple[] = [];
    for (const tr of traces) {
      for (let i = 0; i < (tr.lat?.length || 0); i++) {
        if (!tr.lat[i] || !tr.lon[i]) continue;
        if (range) {
          const d = tr.dist?.[i];
          if (d == null || d < range[0] || d > range[1]) continue;
        }
        pts.push([tr.lat[i], tr.lon[i]]);
      }
    }
    if (pts.length < 2) return;
    map.fitBounds(pts, { padding: [36, 36], maxZoom: 18, animate: false });
  }

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = L.map(ref.current, { zoomControl: true, attributionControl: true });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri",
      maxZoom: 19,
      maxNativeZoom: 19,
      crossOrigin: true,
    }).addTo(map);
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(ref.current);
    setTimeout(() => map.invalidateSize(), 80);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layers.current.forEach((l) => map.removeLayer(l));
    layers.current = [];
    markers.current = {};
    if (!canvasRenderer.current) canvasRenderer.current = L.canvas({ padding: 0.5 });
    const renderer = canvasRenderer.current;
    const nums: number[] = [];
    const speedTo = pref === "metric" ? "km/h" : "mph";
    const mapVal = (key: string, v: number) =>
      key === "gps_speed_mph" ? convertValue(v, "mph", speedTo) : v;
    if (colorBy) {
      for (const tr of data) {
        const y = tr.values?.[colorBy] || [];
        for (const v of y) if (v != null && Number.isFinite(v)) nums.push(mapVal(colorBy, v));
      }
    }
    const range = colorBy ? rainbowRange(colorBy, nums) : null;
    const meta = colorBy ? MAP_COLOR_META[colorBy] : null;
    const legendUnit = colorBy === "gps_speed_mph" ? speedTo : meta?.unit || "";
    if (range && meta) setLegend({ name: meta.name, unit: legendUnit, min: range.min, max: range.max });
    else setLegend(null);
    const multi = data.length > 1;
    const rainbowW = multi ? 2 : 4;
    const underW = multi ? 3 : 6;
    const solidW = multi ? 2 : 3;
    for (const tr of data) {
      const pts: L.LatLngExpression[] = [];
      for (let i = 0; i < tr.lat.length; i++) {
        if (tr.lat[i] && tr.lon[i]) pts.push([tr.lat[i], tr.lon[i]]);
      }
      if (pts.length < 2) continue;
      const chValsRaw = colorBy ? tr.values?.[colorBy] : null;
      const chVals =
        chValsRaw && colorBy === "gps_speed_mph"
          ? chValsRaw.map((v: number | null) => (v == null ? v : mapVal(colorBy, v)))
          : chValsRaw;
      const useRainbow = !!(range && chVals && chVals.length);
      if (useRainbow && range) {
        layers.current.push(
          L.polyline(pts, {
            color: "#111",
            weight: underW,
            opacity: multi ? 0.35 : 0.45,
            interactive: false,
            renderer,
          }).addTo(map)
        );
        for (const seg of rainbowSegments(tr.lat, tr.lon, chVals, range.min, range.max)) {
          layers.current.push(
            L.polyline(seg.pts, {
              color: seg.color,
              weight: rainbowW,
              opacity: multi ? 0.88 : 0.95,
              interactive: false,
              renderer,
              lineCap: "butt",
              lineJoin: "round",
            }).addTo(map)
          );
        }
      }
      const line = L.polyline(pts, {
        color: useRainbow ? "#000" : colorFor(tr.lap_id),
        weight: useRainbow ? Math.max(10, rainbowW * 3) : solidW,
        opacity: useRainbow ? 0 : multi ? 0.75 : 0.85,
        renderer: useRainbow ? undefined : renderer,
      }).addTo(map);
      line.on("click", (e: L.LeafletMouseEvent) => {
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < tr.lat.length; i++) {
          const d = Math.hypot(tr.lat[i] - e.latlng.lat, tr.lon[i] - e.latlng.lng);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        if (placingRef.current) {
          L.DomEvent.stop(e);
          const snapped = snapToTraces(dataRef.current, e.latlng.lat, e.latlng.lng, 0);
          placeRef.current?.(gateFromPoint(snapped.lat, snapped.lon, snapped.heading));
          return;
        }
        const ev = e.originalEvent as MouseEvent | undefined;
        onCursor(tr.dist[best] ?? 0, !!ev?.shiftKey);
      });
      layers.current.push(line);
      const m = L.circleMarker(pts[0], {
        radius: 7,
        color: "#fff",
        weight: 2,
        fillColor: colorFor(tr.lap_id),
        fillOpacity: 0,
        opacity: 0,
      }).addTo(map);
      markers.current[tr.lap_id] = m;
      layers.current.push(m);
    }
    function drawGate(g: Gate, color: string, label: string) {
      if (!g?.a || !g?.b) return;
      const line = L.polyline(
        [
          [g.a.lat, g.a.lon],
          [g.b.lat, g.b.lon],
        ],
        { color, weight: 4, dashArray: "4 3" }
      ).addTo(map);
      layers.current.push(line);
      const mid: L.LatLngExpression = [(g.a.lat + g.b.lat) / 2, (g.a.lon + g.b.lon) / 2];
      layers.current.push(L.tooltip({ permanent: true, direction: "center", className: "" }).setLatLng(mid).setContent(label).addTo(map));
    }
    if (!editSectorsRef.current) {
      (layout?.sectors || []).forEach((g, i) => drawGate(g, "#d29922", `S${i + 1}`));
    }
    if (turns?.length && data.length) {
      const host = data.reduce((a: any, b: any) => ((a?.dist?.length || 0) >= (b?.dist?.length || 0) ? a : b));
      for (const t of turns) {
        if (!host?.dist?.length) break;
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < host.dist.length; i++) {
          const d = Math.abs((host.dist[i] ?? 0) - t.apex_m);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        if (!host.lat[best] || !host.lon[best]) continue;
        const icon = L.divIcon({
          className: "turn-mark",
          html: `<span>T${t.n}</span>`,
          iconSize: [36, 16],
          iconAnchor: [18, 8],
        });
        const marker = L.marker([host.lat[best], host.lon[best]], { icon, interactive: false, keyboard: false }).addTo(map);
        if (t.name) marker.bindTooltip(String(t.name), { direction: "top", offset: [0, -8] });
        layers.current.push(marker);
      }
    }
    fitMap(zoomRangeRef.current);
    setTimeout(() => map.invalidateSize(), 50);
  }, [data, selected.join(","), colorBy, pref, turns?.map((t) => `${t.n}:${t.apex_m}`).join(","), onEditSectors ? "edit" : JSON.stringify(layout?.sectors || [])]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    gateLayers.current.forEach((l) => map.removeLayer(l));
    gateLayers.current = [];
    const stage = (layout?.timing_mode || "loop") === "stage";
    const add = (g: Gate | null | undefined, color: string, label: string, dotClass: string, onEdit?: (g: Gate) => void) => {
      if (!g?.a || !g?.b) return;
      const line = L.polyline(
        [
          [g.a.lat, g.a.lon],
          [g.b.lat, g.b.lon],
        ],
        { color, weight: 5, dashArray: "4 3" }
      ).addTo(map);
      gateLayers.current.push(line);
      const mid: L.LatLngExpression = [(g.a.lat + g.b.lat) / 2, (g.a.lon + g.b.lon) / 2];
      if (onEdit) {
        const icon = L.divIcon({
          className: "sf-handle",
          html: `<div class="sf-handle-dot${dotClass ? ` ${dotClass}` : ""}"></div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        const marker = L.marker(mid, { draggable: true, icon, zIndexOffset: 1200 }).addTo(map);
        marker.bindTooltip(label, { permanent: true, direction: "top", offset: [0, -12], className: "sector-label" });
        const applyAt = (ll: L.LatLng) => {
          const snapped = snapToTraces(data, ll.lat, ll.lng, Number(g.heading) || 0);
          const next = gateFromPoint(snapped.lat, snapped.lon, snapped.heading);
          line.setLatLngs([
            [next.a.lat, next.a.lon],
            [next.b.lat, next.b.lon],
          ]);
          marker.setLatLng([(next.a.lat + next.b.lat) / 2, (next.a.lon + next.b.lon) / 2]);
          return next;
        };
        marker.on("drag", (e) => {
          applyAt((e.target as L.Marker).getLatLng());
        });
        marker.on("dragend", (e) => {
          const next = applyAt((e.target as L.Marker).getLatLng());
          onEdit(next);
        });
        gateLayers.current.push(marker);
      } else {
        gateLayers.current.push(
          L.tooltip({ permanent: true, direction: "center", className: "" }).setLatLng(mid).setContent(label).addTo(map)
        );
      }
    };
    add(layout?.sf_gate, "#e6edf3", stage ? "A" : "S/F", "", editRef.current);
    if (stage) add(layout?.finish_gate, "#ff7931", "B", "finish", editFinishRef.current);
    return () => {
      gateLayers.current.forEach((l) => map.removeLayer(l));
      gateLayers.current = [];
    };
  }, [data, layout?.sf_gate, layout?.finish_gate, layout?.timing_mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !editSectorsRef.current) return;
    sectorLayers.current.forEach((l) => map.removeLayer(l));
    sectorLayers.current = [];
    const sectors = layout?.sectors || [];
    sectors.forEach((g, i) => {
      if (!g?.a || !g?.b) return;
      const selected = selectedSplit === i;
      const line = L.polyline(
        [
          [g.a.lat, g.a.lon],
          [g.b.lat, g.b.lon],
        ],
        { color: selected ? "#f0c040" : "#d29922", weight: selected ? 5 : 4, dashArray: "4 3" }
      ).addTo(map);
      sectorLayers.current.push(line);
      const mid: L.LatLngExpression = [(g.a.lat + g.b.lat) / 2, (g.a.lon + g.b.lon) / 2];
      const icon = L.divIcon({
        className: "sf-handle",
        html: `<div class="sf-handle-dot sector${selected ? " selected" : ""}"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      const marker = L.marker(mid, { draggable: true, icon, zIndexOffset: 1100 }).addTo(map);
      marker.bindTooltip(`S${i + 1}`, {
        permanent: true,
        direction: "top",
        offset: [0, -12],
        className: "sector-label",
      });
      const applyAt = (ll: L.LatLng) => {
        const snapped = snapToTraces(data, ll.lat, ll.lng, Number(g.heading) || 0);
        const next = gateFromPoint(snapped.lat, snapped.lon, snapped.heading);
        line.setLatLngs([
          [next.a.lat, next.a.lon],
          [next.b.lat, next.b.lon],
        ]);
        marker.setLatLng([(next.a.lat + next.b.lat) / 2, (next.a.lon + next.b.lon) / 2]);
        return next;
      };
      marker.on("click", (e) => {
        L.DomEvent.stop(e);
        selectSplitRef.current?.(i);
      });
      marker.on("drag", (e) => {
        applyAt((e.target as L.Marker).getLatLng());
      });
      marker.on("dragend", (e) => {
        const next = applyAt((e.target as L.Marker).getLatLng());
        const arr = sectors.map((s, j) => (j === i ? next : s));
        editSectorsRef.current?.(arr);
      });
      sectorLayers.current.push(marker);
    });
    return () => {
      sectorLayers.current.forEach((l) => map.removeLayer(l));
      sectorLayers.current = [];
    };
  }, [data, JSON.stringify(layout?.sectors || []), selectedSplit, !!onEditSectors]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !placingKind) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      if (!placingRef.current) return;
      L.DomEvent.stop(e);
      const snapped = snapToTraces(dataRef.current, e.latlng.lat, e.latlng.lng, 0);
      placeRef.current?.(gateFromPoint(snapped.lat, snapped.lon, snapped.heading));
    };
    map.on("click", onClick);
    const el = map.getContainer();
    const prev = el.style.cursor;
    el.style.cursor = "crosshair";
    return () => {
      map.off("click", onClick);
      el.style.cursor = prev;
    };
  }, [placingKind, data]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    highlight.current.forEach((l) => map.removeLayer(l));
    highlight.current = [];
    if (!highlightRange) return;
    const [lo, hi] = highlightRange;
    if (hi - lo < 2) return;
    const addTick = (dist: number) => {
      const g = gateAtDist(data, dist);
      if (!g?.a || !g?.b) return;
      const pts: L.LatLngExpression[] = [
        [g.a.lat, g.a.lon],
        [g.b.lat, g.b.lon],
      ];
      highlight.current.push(
        L.polyline(pts, { color: "#1b1f23", weight: 8, opacity: 0.9, interactive: false }).addTo(map)
      );
      highlight.current.push(
        L.polyline(pts, { color: "#f85149", weight: 4, opacity: 1, interactive: false }).addTo(map)
      );
    };
    addTick(lo);
    addTick(hi);
  }, [highlightRange, data]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const drawn: L.Layer[] = [];
    const tick = (dist: number | null | undefined, color: string) => {
      if (dist == null) return;
      const g = gateAtDist(data, dist);
      if (!g?.a || !g?.b) return;
      const pts: L.LatLngExpression[] = [
        [g.a.lat, g.a.lon],
        [g.b.lat, g.b.lon],
      ];
      drawn.push(L.polyline(pts, { color: "#1b1f23", weight: 7, opacity: 0.85, interactive: false }).addTo(map));
      drawn.push(L.polyline(pts, { color, weight: 3, opacity: 1, interactive: false }).addTo(map));
    };
    tick(markA, "#58a6ff");
    tick(markB, "#a371f7");
    return () => {
      drawn.forEach((l) => map.removeLayer(l));
    };
  }, [markA, markB, data]);

  useEffect(() => {
    fitMap(zoomRange ?? null);
  }, [zoomRange, data]);

  function moveMarkers(dist: number | null) {
    for (const tr of data) {
      const m = markers.current[tr.lap_id];
      if (!m || !tr.dist?.length) continue;
      if (dist == null) {
        m.setStyle({ opacity: 0, fillOpacity: 0 });
        continue;
      }
      m.setStyle({ opacity: 1, fillOpacity: 1 });
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < tr.dist.length; i++) {
        const d = Math.abs(tr.dist[i] - dist);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (tr.lat[best] && tr.lon[best]) m.setLatLng([tr.lat[best], tr.lon[best]]);
    }
  }

  useEffect(() => {
    if (!cursorLiveRef) return;
    cursorLiveRef.current = moveMarkers;
    return () => {
      cursorLiveRef.current = () => {};
    };
  }, [data, cursorLiveRef]);

  useEffect(() => {
    moveMarkers(cursorDist);
  }, [cursorDist, data]);

  return (
    <div
      className={`map-wrap${placingKind ? " placing-split" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onUnpin?.();
      }}
    >
      <div
        ref={ref}
        style={{ height: "100%", width: "100%" }}
      />
      {legend && (
        <div className="map-legend">
          <div className="map-legend-label">
            {legend.name}
            {legend.unit ? ` (${legend.unit})` : ""}
          </div>
          <div className="map-legend-bar" />
          <div className="map-legend-ends">
            <span>
              {fmtNum(legend.min, legend.unit === "mph" || legend.unit === "km/h" || legend.unit === "%" ? 0 : 1)}
              {legend.unit ? ` ${legend.unit}` : ""}
            </span>
            <span>
              {fmtNum(legend.max, legend.unit === "mph" || legend.unit === "km/h" || legend.unit === "%" ? 0 : 1)}
              {legend.unit ? ` ${legend.unit}` : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function DeltaChart({
  delta,
  refId,
  colorFor,
  cursorDist,
  pinned,
  markA,
  markB,
  xRange,
  onPin,
  onUnpin,
  onZoom,
  onDragRange,
  onHover,
  laps,
}: {
  delta: any;
  refId: number | null;
  colorFor: (id: number) => string;
  cursorDist: number;
  pinned: boolean;
  markA: number | null;
  markB: number | null;
  xRange: [number, number] | null;
  onPin: (d: number, shift?: boolean) => void;
  onUnpin: () => void;
  onZoom: (range: [number, number]) => void;
  onDragRange: (range: [number, number] | null) => void;
  onHover: (d: number | null) => void;
  laps: Lap[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const xsRef = useRef<number[]>([]);
  const handlers = useRef({ onPin, onUnpin, onZoom, onDragRange, onHover });
  handlers.current = { onPin, onUnpin, onZoom, onDragRange, onHover };
  const marksRef = useRef({ a: markA, b: markB });
  marksRef.current = { a: markA, b: markB };
  const theme = useTheme();

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const pt = plotTheme();
    const series: uPlot.Series[] = [{ label: "dist" }];
    const cols: (number | null)[][] = [];
    let x: number[] = [];
    const others = (delta?.series || []).filter((s: any) => s.lap_id !== refId);
    for (const s of others) {
      if (!x.length) x = s.x;
      const y = (s.y as number[]).map((v) => Number(v));
      const lost = y.map((v) => (v > 0 ? v : 0));
      const gained = y.map((v) => (v < 0 ? v : 0));
      const color = colorFor(s.lap_id);
      series.push({
        label: `L${laps.find((l) => l.id === s.lap_id)?.number ?? s.lap_id} lost`,
        stroke: "rgba(248,81,73,0.9)",
        fill: "rgba(248,81,73,0.28)",
        width: 0,
        points: { show: false },
        fillTo: 0,
      });
      cols.push(lost);
      series.push({
        label: `L${laps.find((l) => l.id === s.lap_id)?.number ?? s.lap_id} gained`,
        stroke: "rgba(63,185,80,0.9)",
        fill: "rgba(63,185,80,0.28)",
        width: 0,
        points: { show: false },
        fillTo: 0,
      });
      cols.push(gained);
      series.push({
        label: `L${laps.find((l) => l.id === s.lap_id)?.number ?? s.lap_id}`,
        stroke: color,
        width: 1.6,
        points: { show: false },
      });
      cols.push(y);
    }
    if (!x.length) {
      plot.current?.destroy();
      plot.current = null;
      return;
    }
    xsRef.current = x;
    const data: uPlot.AlignedData = [x, ...cols];
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(el.clientHeight || 180, 160),
      pxAlign: 0,
      cursor: overlayCursor(),
      select: { show: true },
      legend: { show: false },
      scales: {
        x: xRange ? { time: false, min: xRange[0], max: xRange[1] } : { time: false },
        y: {
          range: (_u, min, max) => {
            const m = Math.max(Math.abs(min), Math.abs(max), 0.15);
            return [-m, m];
          },
        },
      },
      axes: [
        {
          stroke: pt.axis,
          grid: { stroke: pt.grid },
          ticks: { stroke: pt.tick },
          font: "11px sans-serif",
          size: 36,
          values: (_u, vals) => vals.map((v) => String(Math.round(v))),
        },
        {
          stroke: pt.axis,
          grid: { stroke: pt.grid },
          ticks: { stroke: pt.tick },
          font: "11px sans-serif",
          size: 46,
          values: (_u, vals) => vals.map((v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))),
        },
      ],
      series,
      hooks: {
        drawAxes: [
          (u) => {
            const y0 = u.valToPos(0, "y", true);
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = pt.axis;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(u.bbox.left, y0);
            ctx.lineTo(u.bbox.left + u.bbox.width, y0);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = pt.axis;
            ctx.font = "10px sans-serif";
            ctx.fillText("lost", u.bbox.left + 6, u.bbox.top + 12);
            ctx.fillText("gained", u.bbox.left + 6, u.bbox.top + u.bbox.height - 4);
            ctx.restore();
          },
        ],
        setCursor: [(u) => onPlotCursor(u, true, handlers.current.onHover)],
        setScale: [(u) => applyAbMarks(u, marksRef.current.a, marksRef.current.b)],
      },
    };
    plot.current?.destroy();
    const u = new uPlot(opts, data, el);
    plot.current = u;
    const unbind = bindPlotInput(u, {
      onPin: (d, shift) => handlers.current.onPin(d, shift),
      onUnpin: () => handlers.current.onUnpin(),
      onZoom: (r) => handlers.current.onZoom(r),
      onDragRange: (r) => handlers.current.onDragRange(r),
    });
    const ro = new ResizeObserver(() => {
      if (!plot.current || !el) return;
      plot.current.setSize({ width: el.clientWidth, height: Math.max(el.clientHeight, 160) });
    });
    ro.observe(el);
    return () => {
      unbind();
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [delta, refId, theme]);

  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    applyXRange(u, xRange, xsRef.current);
  }, [xRange]);

  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    applyPinnedCursor(u, cursorDist, pinned);
    applyAbMarks(u, markA, markB);
  }, [cursorDist, pinned, markA, markB, xRange]);

  if (!delta?.series?.filter((s: any) => s.lap_id !== refId).length) {
    return <div className="muted" style={{ padding: 12 }}>Select two or more laps to see time gained and lost against the fastest.</div>;
  }
  return <div ref={ref} style={{ height: "100%", width: "100%" }} />;
}

type SectorStat = "min" | "max" | "avg";

function sectorStatVal(sector: any, key: string, stat: SectorStat): number | null {
  const v = sector?.channels?.[key]?.[stat];
  return v == null || Number.isNaN(Number(v)) ? null : Number(v);
}

function sectorDigits(unit: string, key: string): number {
  const u = (unit || "").toLowerCase();
  if (u === "%" || u === "rpm" || key === "rpm") return 0;
  if (u === "g" || u === "λ" || key === "afr") return 2;
  if (u === "mph" || u === "psi" || u === "km/h" || u === "bar" || u === "kpa") return 1;
  return 1;
}

function SplitsTab({
  selected,
  laps,
  colorFor,
  channels,
}: {
  selected: number[];
  laps: Lap[];
  colorFor: (id: number) => string;
  channels: Channel[];
}) {
  const pref = useUnitPref();
  const [data, setData] = useState<any>(null);
  const [chKey, setChKey] = useState("gps_speed_mph");
  const [stat, setStat] = useState<SectorStat>("min");
  useEffect(() => {
    if (!selected.length) return;
    const keys = channels.map((c) => c.key);
    api.splits(selected, keys.length ? keys : undefined).then(setData);
  }, [selected.join(","), channels.map((c) => c.key).join(",")]);
  useEffect(() => {
    if (channels.length && !channels.some((c) => c.key === chKey)) setChKey(channels[0].key);
  }, [channels, chKey]);
  if (!data) return <div className="page muted">Select laps…</div>;
  const sectorIdxs = [...new Set(data.laps.flatMap((l: any) => (l.sectors || []).map((s: any) => s.index)))].sort(
    (a: number, b: number) => a - b
  ) as number[];
  // Last sector absorbs rounding so S1+S2+S3 equals the flown lap time.
  // Virtual best is then comparable to TIME, and sector deltas sum to the lap delta.
  const timedLaps = data.laps.map((l: any) => {
    const sectors = (l.sectors || []).map((s: any) => ({ ...s }));
    const ordered = sectorIdxs.map((idx) => sectors.find((s: any) => s.index === idx)).filter(Boolean) as any[];
    const sum = ordered.reduce((a, s) => a + (s.time_ms ?? 0), 0);
    if (ordered.length && l.time_ms != null && sum) ordered[ordered.length - 1].time_ms += l.time_ms - sum;
    return { ...l, sectors };
  });
  const pool = timedLaps.filter((l: any) => l.kind === "valid");
  const src = pool.length ? pool : timedLaps;
  const refLap = [...src].sort((a: any, b: any) => a.time_ms - b.time_ms)[0] || null;
  const refMs = refLap?.time_ms ?? null;
  const bestBySector = new Map<number, number>();
  for (const idx of sectorIdxs) {
    let best: number | null = null;
    for (const l of src) {
      const s = (l.sectors || []).find((x: any) => x.index === idx);
      if (!s || s.time_ms == null) continue;
      if (best == null || s.time_ms < best) best = s.time_ms;
    }
    if (best != null) bestBySector.set(idx, best);
  }
  // Eclectic / theoretical: API takes min of each complete half-sector across
  // flying laps, then sums. TIME is always S1+S2+S3. Fallback is min of each
  // official sector (same method, coarser windows).
  const virtualBySector = new Map<number, number>();
  for (const s of data.virtual?.sectors || []) {
    if (s?.index == null || s.time_ms == null) continue;
    virtualBySector.set(s.index, s.time_ms);
  }
  if (!virtualBySector.size) {
    for (const idx of sectorIdxs) {
      const t = bestBySector.get(idx);
      if (t != null) virtualBySector.set(idx, t);
    }
  }
  const virtualMs = virtualBySector.size
    ? [...virtualBySector.values()].reduce((a, t) => a + t, 0)
    : data.virtual?.time_ms ?? null;
  const vsBest = virtualMs != null && refMs != null ? virtualMs - refMs : null;
  function refSector(idx: number): number | null {
    const s = (refLap?.sectors || []).find((x: any) => x.index === idx);
    return s?.time_ms ?? null;
  }

  return (
    <div className="page" data-export-root>
      <div className="toolbar-inline" style={{ marginBottom: 12 }}>
        <span className="pill" style={{ color: "var(--purple)", borderColor: "#6e40c9" }}>
          Virtual best {fmtLap(virtualMs)}
          {vsBest != null && vsBest !== 0 && (
            <span className="muted" style={{ marginLeft: 6 }}>
              {fmtDelta(vsBest)} vs L{refLap.number}
            </span>
          )}
        </span>
        <span className="pill">Best flying {fmtLap(refMs)}</span>
        {refLap && <span className="muted">Δ vs L{refLap.number} (fastest selected)</span>}
        <span className="muted" style={{ fontSize: 12 }}>
          Fastest complete half of each official sector, summed. TIME = sum of sectors.
        </span>
        {laps.some((l) => selected.includes(l.id) && l.sectors_source === "equal") && (
          <span className="err">
            Sector beacons were not crossed on a selected lap. Those splits are equal thirds, not the track's sectors. Place splits on the Track tab.
          </span>
        )}
      </div>
      <table className="split-table card">
        <thead>
          <tr>
            <th>Lap</th>
            <th>Time</th>
            {sectorIdxs.map((idx) => (
              <th key={idx}>S{idx}</th>
            ))}
            <th>Kind</th>
          </tr>
        </thead>
        <tbody>
          {virtualMs != null && (
            <tr className="virtual">
              <td>
                <span className="dot" style={{ background: "var(--purple)", display: "inline-block", marginRight: 6 }} />
                Virtual best
              </td>
              <td>
                <SplitStamp time={virtualMs} delta={vsBest} purple />
              </td>
              {sectorIdxs.map((idx) => {
                const t = virtualBySector.get(idx);
                const r = refSector(idx);
                return (
                  <td
                    key={idx}
                    title="Fastest first half + fastest second half of this official sector. Never slower than the best flown S time."
                  >
                    <SplitStamp time={t ?? null} delta={t != null && r != null ? t - r : null} purple />
                  </td>
                );
              })}
              <td>
                <span className="pill" style={{ color: "var(--purple)", borderColor: "#6e40c9" }}>
                  virtual
                </span>
              </td>
            </tr>
          )}
          {timedLaps.map((l: any) => (
            <tr key={l.id}>
              <td>
                <span className="dot" style={{ background: colorFor(l.id), display: "inline-block", marginRight: 6 }} />
                L{l.number}
                {refLap && l.id === refLap.id && <span className="pill best" style={{ marginLeft: 6 }}>ref</span>}
              </td>
              <td>
                <SplitStamp time={l.time_ms} delta={refMs != null ? l.time_ms - refMs : null} best={l.id === refLap?.id} />
              </td>
              {sectorIdxs.map((idx) => {
                const s = (l.sectors || []).find((x: any) => x.index === idx);
                const best = bestBySector.get(idx);
                const r = refSector(idx);
                return (
                  <td key={idx}>
                    <SplitStamp
                      time={s?.time_ms ?? null}
                      delta={s && r != null ? s.time_ms - r : null}
                      purple={s != null && s.time_ms === best}
                    />
                  </td>
                );
              })}
              <td>
                <span className={`pill ${l.kind}`}>{l.kind}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sectorIdxs.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>
            Sector channels
            <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
              min / max / avg in each sector vs L{refLap?.number ?? "ref"}
            </span>
          </h3>
          <div className="toolbar-inline" style={{ margin: "8px 0" }}>
            <select
              className="kind-select"
              value={chKey}
              onChange={(e) => setChKey(e.target.value)}
            >
              {(channels.length ? channels : [{ key: "gps_speed_mph", name: "GPS Speed", unit: "mph" }]).map((c) => {
                const shown = displayChannel(c, pref);
                return (
                <option key={c.key} value={c.key}>{shown.name}{shown.unit ? ` (${shown.unit})` : ""}</option>
                );
              })}
            </select>
            <span className="hist-seg">
              {(["min", "max", "avg"] as SectorStat[]).map((s) => (
                <button key={s} className={stat === s ? "primary" : "ghost"} onClick={() => setStat(s)}>
                  {s}
                </button>
              ))}
            </span>
          </div>
          {(() => {
            const meta = channels.find((c) => c.key === chKey);
            const shown = meta ? displayChannel(meta, pref) : undefined;
            const unit = shown?.unit || meta?.unit || "";
            const digits = sectorDigits(unit, chKey);
            const toDisp = (v: number | null) => convertMaybe(v, meta?.unit || "", unit);
            const label = `${stat} ${meta?.name || chKey}`;
            const betterHigh = chKey.includes("speed") && stat === "min";
            const bestOf = (idx: number) => {
              if (!betterHigh) return null;
              let best: number | null = null;
              for (const l of src) {
                const s = (l.sectors || []).find((x: any) => x.index === idx);
                const v = sectorStatVal(s, chKey, stat);
                if (v == null) continue;
                if (best == null || v > best) best = v;
              }
              return best;
            };
            const refVal = (idx: number) => {
              const s = (refLap?.sectors || []).find((x: any) => x.index === idx);
              return sectorStatVal(s, chKey, stat);
            };
            return (
              <table className="split-table card">
                <thead>
                  <tr>
                    <th>Lap</th>
                    {sectorIdxs.map((idx) => (
                      <th key={idx}>
                        S{idx}
                        <div className="muted" style={{ fontWeight: 400, fontSize: 11 }}>
                          {label}{unit ? ` (${unit})` : ""}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.laps.map((l: any) => (
                    <tr key={l.id}>
                      <td>
                        <span className="dot" style={{ background: colorFor(l.id), display: "inline-block", marginRight: 6 }} />
                        L{l.number}
                        {refLap && l.id === refLap.id && <span className="pill best" style={{ marginLeft: 6 }}>ref</span>}
                      </td>
                      {sectorIdxs.map((idx) => {
                        const s = (l.sectors || []).find((x: any) => x.index === idx);
                        const v = sectorStatVal(s, chKey, stat);
                        const r = refVal(idx);
                        const best = bestOf(idx);
                        const dv = toDisp(v);
                        const dr = toDisp(r);
                        const delta = dv != null && dr != null ? dv - dr : null;
                        const good = betterHigh && delta != null ? delta > 0.05 : null;
                        return (
                          <td key={idx} title={s?.d0_m != null ? `${fmtNum(s.d0_m, 0)}–${fmtNum(s.d1_m, 0)} m` : undefined}>
                            <div className={best != null && v != null && v === best ? "purple" : ""}>
                              {dv == null ? "—" : fmtNum(dv, digits)}
                            </div>
                            {delta != null && l.id !== refLap?.id && (
                              <div
                                className={`split-delta ${
                                  good === true ? "ahead" : good === false ? "behind" : "even"
                                }`}
                              >
                                {delta > 0 ? "+" : ""}
                                {fmtNum(delta, digits)}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
        </>
      )}
      {refLap && sectorIdxs.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>Time gained / lost vs L{refLap.number}</h3>
          <SectorGainChart laps={timedLaps} sectorIdxs={sectorIdxs} refLap={refLap} colorFor={colorFor} />
        </>
      )}
      <h3 style={{ marginTop: 16 }}>Mini-sectors (purple = fastest in selection)</h3>
      <MiniSectorBar laps={data.laps} purple={data.purple_ms || []} colorFor={colorFor} />
    </div>
  );
}

function SplitStamp({
  time,
  delta,
  purple,
  best,
}: {
  time: number | null | undefined;
  delta: number | null | undefined;
  purple?: boolean;
  best?: boolean;
}) {
  if (time == null) return <>{"—"}</>;
  return (
    <>
      <div className={purple ? "purple" : best ? "best" : ""}>{fmtLap(time)}</div>
      {delta != null && (
        <div className={`split-delta ${delta < 0 ? "ahead" : delta > 0 ? "behind" : "even"}`}>{fmtDelta(delta)}</div>
      )}
    </>
  );
}

function SectorGainChart({
  laps,
  sectorIdxs,
  refLap,
  colorFor,
}: {
  laps: any[];
  sectorIdxs: number[];
  refLap: any;
  colorFor: (id: number) => string;
}) {
  const rows = laps.filter((l) => l.kind === "valid" || l.id === refLap.id);
  const deltas = rows.flatMap((l) =>
    sectorIdxs.map((idx) => {
      const s = (l.sectors || []).find((x: any) => x.index === idx);
      const r = (refLap.sectors || []).find((x: any) => x.index === idx);
      if (!s || !r) return 0;
      return s.time_ms - r.time_ms;
    })
  );
  const maxAbs = Math.max(200, ...deltas.map((d) => Math.abs(d)));
  return (
    <div className="card sector-gain">
      {sectorIdxs.map((idx) => (
        <div key={idx} className="sector-gain-col">
          <div className="muted" style={{ marginBottom: 6 }}>S{idx}</div>
          {rows.map((l) => {
            const s = (l.sectors || []).find((x: any) => x.index === idx);
            const r = (refLap.sectors || []).find((x: any) => x.index === idx);
            const d = s && r ? s.time_ms - r.time_ms : 0;
            const pct = (Math.abs(d) / maxAbs) * 50;
            return (
              <div key={l.id} className="sector-gain-row">
                <span className="mini-lap-label" style={{ color: colorFor(l.id) }}>
                  L{l.number}
                </span>
                <div className="sector-gain-bar">
                  <div className="zero" />
                  {d < 0 && (
                    <div className="fill ahead" style={{ width: `${pct}%`, right: "50%" }} />
                  )}
                  {d > 0 && (
                    <div className="fill behind" style={{ width: `${pct}%`, left: "50%" }} />
                  )}
                </div>
                <span className={`split-delta ${d < 0 ? "ahead" : d > 0 ? "behind" : "even"}`}>{fmtDelta(d)}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function sectorBoundaries(laps: any[]): number[] {
  const src =
    [...laps].sort(
      (a, b) => (a.kind === "valid" ? 0 : 1) - (b.kind === "valid" ? 0 : 1) || a.time_ms - b.time_ms
    ).find((l) => l.sectors?.length) || laps[0];
  const secs = [...(src?.sectors || [])].sort((a: any, b: any) => a.index - b.index);
  const edges: number[] = [];
  let acc = 0;
  for (let i = 0; i < secs.length - 1; i++) {
    acc += Number(secs[i].distance_m) || 0;
    if (acc > 0) edges.push(acc);
  }
  if (edges.length) return edges;
  const maxD = Math.max(0, ...laps.flatMap((l) => (l.mini || []).map((m: any) => m.d1 || 0)));
  if (maxD > 0) return [maxD / 3, (2 * maxD) / 3];
  return [];
}

function groupMinis(minis: any[], edges: number[]): any[][] {
  const n = edges.length + 1;
  const groups: any[][] = Array.from({ length: n }, () => []);
  if (!minis.length) return groups;
  if (!edges.length) {
    groups[0] = minis;
    return groups;
  }
  for (const m of minis) {
    const mid = ((m.d0 ?? 0) + (m.d1 ?? 0)) / 2;
    let g = edges.length;
    for (let i = 0; i < edges.length; i++) {
      if (mid < edges[i]) {
        g = i;
        break;
      }
    }
    groups[g].push(m);
  }
  return groups;
}

function MiniSectorBar({
  laps,
  purple,
  colorFor,
}: {
  laps: any[];
  purple: number[];
  colorFor: (id: number) => string;
}) {
  const edges = sectorBoundaries(laps);
  const sample = laps.find((l) => l.mini?.length)?.mini || [];
  const groups = groupMinis(sample, edges);
  const labels = groups.map((_, i) => `S${i + 1}`);
  return (
    <div className="card">
      {!!sample.length && (
        <div className="mini-row mini-legend">
          <span className="mini-lap-label" />
          <div className="mini-track">
            {groups.map((g, i) => (
              <Fragment key={i}>
                {i > 0 && <div className="mini-gap" />}
                <div className="mini-group" style={{ flex: Math.max(g.length, 1) }}>
                  <span className="mini-sec-label">{labels[i]}</span>
                </div>
              </Fragment>
            ))}
          </div>
        </div>
      )}
      {laps.map((l) => {
        const grouped = groupMinis(l.mini || [], edges);
        return (
          <div key={l.id} className="mini-row">
            <span className="mini-lap-label" style={{ color: colorFor(l.id) }}>
              L{l.number}
            </span>
            <div className="mini-track">
              {grouped.map((g, gi) => (
                <Fragment key={gi}>
                  {gi > 0 && <div className="mini-gap" />}
                  <div className="mini-group" style={{ flex: Math.max(g.length, 1) }}>
                    <div className="mini-cells">
                      {g.map((m: any) => {
                        const i = m.index ?? 0;
                        const isP = purple[i] != null && m.time_ms === purple[i];
                        return (
                          <div
                            key={i}
                            title={labels[gi]}
                            className={`mini-cell${isP ? " purple" : ""}`}
                            style={{ background: isP ? "#a371f7" : colorFor(l.id) }}
                          />
                        );
                      })}
                    </div>
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function sampleAtDist(dist: number[], vals: number[], d: number): number | null {
  if (!dist.length || !vals.length) return null;
  const n = Math.min(dist.length, vals.length);
  if (d <= dist[0]) return Number.isFinite(vals[0]) ? vals[0] : null;
  if (d >= dist[n - 1]) return Number.isFinite(vals[n - 1]) ? vals[n - 1] : null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (dist[m] <= d) lo = m;
    else hi = m;
  }
  const a = vals[lo];
  const b = vals[hi];
  const span = dist[hi] - dist[lo] || 1;
  const t = (d - dist[lo]) / span;
  if (Number.isFinite(a) && Number.isFinite(b)) return a + t * (b - a);
  return Number.isFinite(a) ? a : Number.isFinite(b) ? b : null;
}

function GateBar({
  preset,
  gates,
  channels,
  onPreset,
  onGates,
  unitPref,
  onUnitPref,
}: {
  preset: GatePreset;
  gates: DataGate[];
  channels: Channel[];
  onPreset: (p: GatePreset) => void;
  onGates: (g: DataGate[]) => void;
  unitPref: UnitPref;
  onUnitPref: (p: UnitPref) => void;
}) {
  function pick(id: GatePreset) {
    onPreset(id);
    const spec = GATE_PRESETS.find((p) => p.id === id);
    if (!spec) return;
    if (id === "off") {
      onGates([]);
      return;
    }
    if (id === "speed") {
      const metric = unitPref === "metric";
      const hasKmh = channels.some((c) => c.key === "gps_speed");
      onGates([{ channel: metric && hasKmh ? "gps_speed" : "gps_speed_mph", op: ">=", value: metric ? 130 : 80 }]);
      return;
    }
    onGates(spec.gates.map((g) => ({ ...g })));
  }
  function patch(i: number, next: Partial<DataGate>) {
    onGates(gates.map((g, j) => (j === i ? { ...g, ...next } : g)));
  }
  const chOpts = channels.length
    ? channels
    : [
        { key: "brake", name: "Brake", unit: "%" },
        { key: "tps", name: "Throttle", unit: "%" },
        { key: "gps_speed_mph", name: "GPS Speed", unit: "mph" },
      ];
  const active = preset !== "off" && gates.length > 0;
  return (
    <div className={`gatebar${active ? " on" : ""}`}>
      <span className="muted">Units</span>
      <span className="hist-seg">
        <button type="button" className={unitPref === "metric" ? "primary" : "ghost"} onClick={() => onUnitPref("metric")}>
          Metric
        </button>
        <button type="button" className={unitPref === "imperial" ? "primary" : "ghost"} onClick={() => onUnitPref("imperial")}>
          Imperial
        </button>
      </span>
      <span className="muted">Gate</span>
      <select className="kind-select" value={preset} onChange={(e) => pick(e.target.value as GatePreset)}>
        {GATE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      {preset === "custom" ? (
        <div className="gate-custom">
          {gates.map((g, i) => (
            <span key={i} className="gate-cond">
              {i > 0 && <span className="muted">and</span>}
              <select className="kind-select" value={g.channel} onChange={(e) => patch(i, { channel: e.target.value })}>
                {chOpts.map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
              </select>
              <select className="kind-select" value={g.op} onChange={(e) => patch(i, { op: e.target.value as GateOp })}>
                {GATE_OPS.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
              <input
                type="number"
                step="any"
                value={Number.isFinite(g.value) ? g.value : ""}
                onChange={(e) => patch(i, { value: e.target.value === "" ? NaN : Number(e.target.value) })}
              />
              {gates.length > 1 && (
                <button className="ghost" type="button" onClick={() => onGates(gates.filter((_, j) => j !== i))} title="Remove">
                  ×
                </button>
              )}
            </span>
          ))}
          <button
            className="ghost"
            type="button"
            onClick={() => onGates([...gates, { channel: chOpts[0]?.key || "tps", op: ">", value: 50 }])}
          >
            + and
          </button>
        </div>
      ) : (
        active && <span className="pill">{gateSummary(gates, channels)}</span>
      )}
      <span className="muted gate-hint">Scatter · Histogram · AFR · Report</span>
    </div>
  );
}

function OverlayScatter({
  selected,
  channels,
  colorFor,
  cursorDist,
  cursorLiveRef,
  xRange,
  gates,
  markA,
  markB,
  onUnpin,
  refId,
}: {
  selected: number[];
  channels: Channel[];
  colorFor: (id: number) => string;
  cursorDist: number | null;
  cursorLiveRef?: { current: (d: number | null) => void };
  xRange: [number, number] | null;
  gates?: string;
  markA?: number | null;
  markB?: number | null;
  onUnpin?: () => void;
  refId?: number | null;
}) {
  const pref = useUnitPref();
  const [xKey, setXKey] = useState("gps_lat_g");
  const [yKey, setYKey] = useState("gps_long_g");
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [data, setData] = useState<any>(null);
  const gDefaulted = useRef(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hoverDist = useRef<number | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const colorRef = useRef(colorFor);
  colorRef.current = colorFor;
  const viewRef = useRef<{ x0: number; x1: number; y0: number; y1: number } | null>(null);
  const fitRef = useRef<{ x0: number; x1: number; y0: number; y1: number } | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    view: { x0: number; x1: number; y0: number; y1: number };
  } | null>(null);
  const theme = useTheme();

  useEffect(() => {
    viewRef.current = null;
  }, [data, xKey, yKey, xRange, markA, markB]);

  useEffect(() => {
    const keys = new Set(channels.map((c) => c.key));
    if (keys.size && !keys.has(xKey)) setXKey(channels[0]?.key || xKey);
    if (keys.size && !keys.has(yKey)) setYKey(channels[1]?.key || channels[0]?.key || yKey);
    if (!gDefaulted.current && keys.has("lat_g") && keys.has("long_g")) {
      setXKey("lat_g");
      setYKey("long_g");
      gDefaulted.current = true;
    }
  }, [channels]);

  const abWin =
    markA != null && markB != null && Math.abs(markB - markA) >= 2
      ? ([Math.min(markA, markB), Math.max(markA, markB)] as [number, number])
      : null;
  const scatterWin = abWin || xRange;

  useEffect(() => {
    if (selected.length) {
      api.scatter(selected, xKey, yKey, {
        gates: gates || undefined,
        distMin: scatterWin?.[0],
        distMax: scatterWin?.[1],
        refLapId: refId,
      }).then(setData).catch(() => setData(null));
    } else setData(null);
  }, [selected.join(","), xKey, yKey, gates, scatterWin?.[0], scatterWin?.[1], refId]);

  useEffect(() => {
    hoverDist.current = cursorDist;
  }, [cursorDist]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const pad = 36;
    const xCh = channels.find((ch) => ch.key === xKey);
    const yCh = channels.find((ch) => ch.key === yKey);
    const xNative = xCh?.unit || "";
    const yNative = yCh?.unit || "";
    const xDisp = preferredUnit(xNative, pref);
    const yDisp = preferredUnit(yNative, pref);
    const xName = channelAxisLabel(xCh ? displayChannel(xCh, pref) : undefined, xKey);
    const yName = channelAxisLabel(yCh ? displayChannel(yCh, pref) : undefined, yKey);
    type View = { x0: number; x1: number; y0: number; y1: number };
    const canvasXY = (e: { clientX: number; clientY: number }) => {
      const rect = c.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (c.width / Math.max(rect.width, 1)),
        y: (e.clientY - rect.top) * (c.height / Math.max(rect.height, 1)),
      };
    };
    const toData = (mx: number, my: number, v: View, w: number, h: number) => {
      let tx = (mx - pad) / Math.max(w - pad * 2, 1);
      let ty = (h - pad - my) / Math.max(h - pad * 2, 1);
      if (flipX) tx = 1 - tx;
      if (flipY) ty = 1 - ty;
      return {
        x: v.x0 + tx * (v.x1 - v.x0),
        y: v.y0 + ty * (v.y1 - v.y0),
      };
    };
    const clampView = (next: View): View | null => {
      const fit = fitRef.current;
      if (!fit) return next;
      const maxX = fit.x1 - fit.x0;
      const maxY = fit.y1 - fit.y0;
      let spanX = Math.min(maxX, Math.max(maxX / 50, next.x1 - next.x0));
      let spanY = Math.min(maxY, Math.max(maxY / 50, next.y1 - next.y0));
      const cx = (next.x0 + next.x1) / 2;
      const cy = (next.y0 + next.y1) / 2;
      let x0 = cx - spanX / 2;
      let x1 = cx + spanX / 2;
      let y0 = cy - spanY / 2;
      let y1 = cy + spanY / 2;
      if (x0 < fit.x0) {
        x1 += fit.x0 - x0;
        x0 = fit.x0;
      }
      if (x1 > fit.x1) {
        x0 -= x1 - fit.x1;
        x1 = fit.x1;
      }
      if (y0 < fit.y0) {
        y1 += fit.y0 - y0;
        y0 = fit.y0;
      }
      if (y1 > fit.y1) {
        y0 -= y1 - fit.y1;
        y1 = fit.y1;
      }
      x0 = Math.max(fit.x0, x0);
      x1 = Math.min(fit.x1, x1);
      y0 = Math.max(fit.y0, y0);
      y1 = Math.min(fit.y1, y1);
      const close = (a: number, b: number, span: number) => Math.abs(a - b) <= span * 0.004;
      if (close(x0, fit.x0, maxX) && close(x1, fit.x1, maxX) && close(y0, fit.y0, maxY) && close(y1, fit.y1, maxY)) {
        return null;
      }
      return { x0, x1, y0, y1 };
    };
    const draw = () => {
      const w = (c.width = Math.max(2, c.clientWidth * 2));
      const h = (c.height = Math.max(2, c.clientHeight * 2));
      const pt = plotTheme();
      ctx.fillStyle = pt.bg;
      ctx.fillRect(0, 0, w, h);
      const series = data?.series || [];
      const inWin = (d: number) => !scatterWin || (d >= scatterWin[0] && d <= scatterWin[1]);
      const vis = series.map((s: any) => {
        const dist = s.dist || [];
        const xs: number[] = [];
        const ys: number[] = [];
        for (let i = 0; i < s.x.length; i++) {
          if (dist[i] != null && !inWin(dist[i])) continue;
          if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i])) continue;
          xs.push(convertValue(s.x[i], xNative, xDisp));
          ys.push(convertValue(s.y[i], yNative, yDisp));
        }
        return { ...s, x: xs, y: ys };
      });
      const allX = vis.flatMap((s: any) => s.x);
      const allY = vis.flatMap((s: any) => s.y);
      if (!allX.length || !allY.length) {
        fitRef.current = null;
        ctx.fillStyle = pt.muted;
        ctx.font = "22px sans-serif";
        ctx.fillText(abWin ? "No points in A–B window" : gates ? "No points in gate" : "No scatter data", 16, h / 2);
        return;
      }
      const limX = Math.max(0.2, ...allX.map((v: number) => Math.abs(v)));
      const limY = Math.max(0.2, ...allY.map((v: number) => Math.abs(v)));
      const fit: View = { x0: -limX, x1: limX, y0: -limY, y1: limY };
      fitRef.current = fit;
      const v = viewRef.current || fit;
      const sx = (val: number) => {
        const t = (val - v.x0) / (v.x1 - v.x0 || 1);
        return pad + (flipX ? 1 - t : t) * (w - pad * 2);
      };
      const sy = (val: number) => {
        const t = (val - v.y0) / (v.y1 - v.y0 || 1);
        return h - pad - (flipY ? 1 - t : t) * (h - pad * 2);
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad, pad, w - pad * 2, h - pad * 2);
      ctx.clip();
      ctx.strokeStyle = pt.tick;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      const ox = sx(0);
      const oy = sy(0);
      if (ox >= pad && ox <= w - pad) {
        ctx.moveTo(ox, pad);
        ctx.lineTo(ox, h - pad);
      }
      if (oy >= pad && oy <= h - pad) {
        ctx.moveTo(pad, oy);
        ctx.lineTo(w - pad, oy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const s of vis) {
        ctx.fillStyle = colorRef.current(s.lap_id);
        ctx.globalAlpha = 0.4;
        for (let i = 0; i < s.x.length; i++) {
          ctx.fillRect(sx(s.x[i]) - 2, sy(s.y[i]) - 2, 4, 4);
        }
      }
      ctx.globalAlpha = 1;
      const markAt = (dist: number | null | undefined, stroke: string, label: string) => {
        if (dist == null) return;
        for (const s of series) {
          const xv = sampleAtDist(s.dist || [], s.x || [], dist);
          const yv = sampleAtDist(s.dist || [], s.y || [], dist);
          if (xv == null || yv == null) continue;
          const px = sx(xv);
          const py = sy(yv);
          ctx.beginPath();
          ctx.arc(px, py, 9, 0, Math.PI * 2);
          ctx.fillStyle = colorRef.current(s.lap_id);
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = stroke;
          ctx.stroke();
          ctx.font = "700 16px sans-serif";
          ctx.lineWidth = 3;
          ctx.strokeStyle = pt.labelBg;
          ctx.strokeText(label, px + 10, py - 8);
          ctx.fillStyle = stroke;
          ctx.fillText(label, px + 10, py - 8);
        }
      };
      markAt(markA, "#58a6ff", "A");
      markAt(markB, "#a371f7", "B");
      const dist = hoverDist.current ?? cursorDist;
      if (dist != null) {
        for (const s of series) {
          const xv = sampleAtDist(s.dist || [], s.x || [], dist);
          const yv = sampleAtDist(s.dist || [], s.y || [], dist);
          if (xv == null || yv == null) continue;
          const px = sx(xv);
          const py = sy(yv);
          const color = colorRef.current(s.lap_id);
          ctx.beginPath();
          ctx.arc(px, py, 7, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = pt.labelFg;
          ctx.stroke();
          const text = `${formatPointValue(xv)} / ${formatPointValue(yv)}`;
          ctx.font = "600 18px sans-serif";
          const tw = ctx.measureText(text).width;
          const bx = Math.min(Math.max(pad + 4, px + 12), w - pad - tw - 18);
          const by = Math.min(Math.max(pad + 18, py - 22), h - pad - 8);
          ctx.fillStyle = pt.labelBg;
          ctx.strokeStyle = pt.tick;
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") ctx.roundRect(bx, by - 14, tw + 12, 22, 4);
          else ctx.rect(bx, by - 14, tw + 12, 22);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = pt.labelFg;
          ctx.fillText(text, bx + 6, by + 3);
        }
      }
      ctx.restore();
      ctx.fillStyle = pt.muted;
      ctx.font = "16px sans-serif";
      ctx.fillText(xName, w / 2 - ctx.measureText(xName).width / 2, h - 8);
      ctx.save();
      ctx.translate(14, h / 2 + ctx.measureText(yName).width / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(yName, 0, 0);
      ctx.restore();
    };
    drawRef.current = draw;
    draw();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const fit = fitRef.current;
      if (!fit) return;
      const v = viewRef.current || fit;
      const p = canvasXY(e);
      const d = toData(p.x, p.y, v, c.width, c.height);
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      if (e.deltaMode === 2) dy *= 400;
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(dy * 0.002)));
      viewRef.current = clampView({
        x0: d.x - (d.x - v.x0) * factor,
        x1: d.x + (v.x1 - d.x) * factor,
        y0: d.y - (d.y - v.y0) * factor,
        y1: d.y + (v.y1 - d.y) * factor,
      });
      draw();
    };
    const onDblClick = (e: MouseEvent) => {
      e.preventDefault();
      viewRef.current = null;
      dragRef.current = null;
      draw();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const v = viewRef.current;
      if (!v) return;
      c.setPointerCapture(e.pointerId);
      dragRef.current = { x: e.clientX, y: e.clientY, view: { ...v } };
    };
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const rect = c.getBoundingClientRect();
      const dxPx = (e.clientX - drag.x) * (c.width / Math.max(rect.width, 1));
      const dyPx = (e.clientY - drag.y) * (c.height / Math.max(rect.height, 1));
      const v = drag.view;
      const plotW = Math.max(c.width - pad * 2, 1);
      const plotH = Math.max(c.height - pad * 2, 1);
      const xDir = flipX ? 1 : -1;
      const yDir = flipY ? -1 : 1;
      viewRef.current = clampView({
        x0: v.x0 + xDir * (dxPx / plotW) * (v.x1 - v.x0),
        x1: v.x1 + xDir * (dxPx / plotW) * (v.x1 - v.x0),
        y0: v.y0 + yDir * (dyPx / plotH) * (v.y1 - v.y0),
        y1: v.y1 + yDir * (dyPx / plotH) * (v.y1 - v.y0),
      });
      draw();
    };
    const onPointerUp = (e: PointerEvent) => {
      dragRef.current = null;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    c.addEventListener("dblclick", onDblClick);
    c.addEventListener("pointerdown", onPointerDown);
    c.addEventListener("pointermove", onPointerMove);
    c.addEventListener("pointerup", onPointerUp);
    c.addEventListener("pointercancel", onPointerUp);
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(c);
    return () => {
      ro.disconnect();
      c.removeEventListener("wheel", onWheel);
      c.removeEventListener("dblclick", onDblClick);
      c.removeEventListener("pointerdown", onPointerDown);
      c.removeEventListener("pointermove", onPointerMove);
      c.removeEventListener("pointerup", onPointerUp);
      c.removeEventListener("pointercancel", onPointerUp);
    };
  }, [data, xKey, yKey, cursorDist, channels, xRange, theme, gates, markA, markB, scatterWin?.[0], scatterWin?.[1], pref, flipX, flipY]);

  useEffect(() => {
    if (!cursorLiveRef) return;
    cursorLiveRef.current = (d) => {
      hoverDist.current = d;
      drawRef.current();
    };
    return () => {
      cursorLiveRef.current = () => {};
    };
  }, [cursorLiveRef, data, xKey, yKey]);

  return (
    <>
      <h3 className="scatter-head">
        <span className="scatter-head-title">
          Scatter
          {abWin ? <span className="pill">A–B</span> : null}
          {gates ? <span className="pill">gated</span> : null}
        </span>
        <span className="scatter-head-controls">
          <select value={xKey} onChange={(e) => setXKey(e.target.value)} className="kind-select" title="X axis">
            {channels.map((c) => (
              <option key={c.key} value={c.key}>{c.name}</option>
            ))}
          </select>
          <span className="muted">vs</span>
          <select value={yKey} onChange={(e) => setYKey(e.target.value)} className="kind-select" title="Y axis">
            {channels.map((c) => (
              <option key={c.key} value={c.key}>{c.name}</option>
            ))}
          </select>
          <span className="scatter-flips">
            <button
              type="button"
              className={flipX ? "primary" : "ghost"}
              title="Mirror left and right"
              onClick={() => setFlipX((f) => !f)}
            >
              Flip X
            </button>
            <button
              type="button"
              className={flipY ? "primary" : "ghost"}
              title="Mirror up and down"
              onClick={() => setFlipY((f) => !f)}
            >
              Flip Y
            </button>
          </span>
        </span>
      </h3>
      <canvas
        ref={canvas}
        className="scatter-canvas"
        title="Scroll wheel to zoom · drag to pan · double-click to reset · right-click to clear A/B"
        onContextMenu={(e) => {
          e.preventDefault();
          onUnpin?.();
        }}
      />
    </>
  );
}

function defaultHistThreshold(key: string): number | "" {
  if (key === "tps") return 90;
  if (key === "brake") return 10;
  return "";
}

function HistTab({
  selected,
  channels,
  colorFor,
  laps,
  xRange,
  gates,
  refId,
}: {
  selected: number[];
  channels: Channel[];
  colorFor: (id: number) => string;
  laps: Lap[];
  xRange: [number, number] | null;
  gates?: string;
  refId?: number | null;
}) {
  const [ch, setCh] = useState("gps_speed_mph");
  const [bins, setBins] = useState(24);
  const [mode, setMode] = useState<"pct" | "seconds">("pct");
  const [useZoom, setUseZoom] = useState(true);
  const [threshold, setThreshold] = useState<number | "">(defaultHistThreshold("gps_speed_mph"));
  const [data, setData] = useState<any>(null);
  const [hoverBin, setHoverBin] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<number | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const colorRef = useRef(colorFor);
  colorRef.current = colorFor;
  const theme = useTheme();

  const pref = useUnitPref();
  const chMeta = channels.find((c) => c.key === ch);
  const shown = chMeta ? displayChannel(chMeta, pref) : undefined;
  const nativeU = chMeta?.unit || "";
  const dispU = shown?.unit || nativeU;
  const windowed = useZoom && xRange != null;

  useEffect(() => {
    setThreshold(defaultHistThreshold(ch));
  }, [ch]);

  useEffect(() => {
    if (!selected.length) {
      setData(null);
      return;
    }
    const opts: { bins: number; distMin?: number; distMax?: number; threshold?: number | null; gates?: string; refLapId?: number | null } = { bins };
    if (windowed && xRange) {
      opts.distMin = xRange[0];
      opts.distMax = xRange[1];
    }
    if (threshold !== "" && Number.isFinite(Number(threshold))) {
      opts.threshold = convertValue(Number(threshold), dispU, nativeU);
    }
    if (gates) opts.gates = gates;
    if (refId) opts.refLapId = refId;
    api.histogram(selected, ch, opts).then(setData).catch(() => setData(null));
  }, [selected.join(","), ch, bins, windowed, xRange?.[0], xRange?.[1], threshold, gates, nativeU, dispU, refId]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const draw = () => {
      const w = (c.width = Math.max(2, c.clientWidth * 2));
      const h = (c.height = Math.max(2, c.clientHeight * 2));
      const pt = plotTheme();
      ctx.fillStyle = pt.bg;
      ctx.fillRect(0, 0, w, h);
      const edges: number[] = (data?.edges || []).map((v: number) => convertValue(v, nativeU, dispU));
      const series = data?.series || [];
      const n = edges.length - 1;
      if (n < 1 || !series.length) {
        ctx.fillStyle = pt.muted;
        ctx.font = "22px sans-serif";
        ctx.fillText("No histogram data for this window", 24, h / 2);
        return;
      }
      const padL = 72;
      const padR = 18;
      const padT = 16;
      const padB = 44;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      const key = mode === "pct" ? "pct" : "seconds";
      const maxY = Math.max(
        0.5,
        ...series.flatMap((s: any) => (s[key] as number[]) || []),
      );
      const binW = plotW / n;
      const hover = hoverRef.current;
      if (hover != null && hover >= 0 && hover < n) {
        ctx.fillStyle = "rgba(88, 166, 255, 0.12)";
        ctx.fillRect(padL + hover * binW, padT, binW, plotH);
      }
      ctx.strokeStyle = pt.grid;
      ctx.lineWidth = 1;
      ctx.font = "18px sans-serif";
      ctx.fillStyle = pt.muted;
      const yTicks = 4;
      for (let i = 0; i <= yTicks; i++) {
        const v = (maxY * i) / yTicks;
        const yy = padT + plotH - (v / maxY) * plotH;
        ctx.beginPath();
        ctx.moveTo(padL, yy);
        ctx.lineTo(w - padR, yy);
        ctx.stroke();
        const label = mode === "pct" ? `${v.toFixed(v >= 10 ? 0 : 1)}%` : `${v.toFixed(v >= 10 ? 0 : 1)}s`;
        ctx.fillText(label, 8, yy + 6);
      }
      for (const s of series) {
        const vals: number[] = s[key] || [];
        ctx.fillStyle = colorRef.current(s.lap_id);
        ctx.globalAlpha = 0.38;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const bh = ((vals[i] || 0) / maxY) * plotH;
          const x = padL + i * binW;
          ctx.fillRect(x + 1, padT + plotH - bh, Math.max(1, binW - 2), bh);
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colorRef.current(s.lap_id);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const bh = ((vals[i] || 0) / maxY) * plotH;
          const x = padL + i * binW + binW / 2;
          const yy = padT + plotH - bh;
          if (i === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = pt.muted;
      ctx.font = "18px sans-serif";
      const tickEvery = Math.max(1, Math.ceil(n / 8));
      for (let i = 0; i <= n; i += tickEvery) {
        const x = padL + i * binW;
        const v = edges[Math.min(i, edges.length - 1)];
        const text = fmtNum(v, Math.abs(v) >= 100 ? 0 : 1);
        ctx.fillText(text, x - ctx.measureText(text).width / 2, h - 14);
      }
      const unit = dispU ? ` (${dispU})` : "";
      const xTitle = `${shown?.name || chMeta?.name || ch}${unit}`;
      ctx.fillText(xTitle, padL + (plotW - ctx.measureText(xTitle).width) / 2, h - 2);
      if (hover != null && hover >= 0 && hover < n) {
        const lo = edges[hover];
        const hi = edges[hover + 1];
        const lines = [`${fmtNum(lo, 1)} – ${fmtNum(hi, 1)}${unit}`];
        for (const s of series) {
          const lap = laps.find((l) => l.id === s.lap_id);
          const v = s[key][hover] || 0;
          lines.push(`L${lap?.number ?? s.lap_id}  ${mode === "pct" ? v.toFixed(1) + "%" : v.toFixed(2) + "s"}`);
        }
        ctx.font = "600 18px sans-serif";
        const tw = Math.max(...lines.map((t) => ctx.measureText(t).width));
        let bx = padL + hover * binW + binW + 8;
        if (bx + tw + 20 > w - 8) bx = padL + hover * binW - tw - 24;
        const by = padT + 8;
        ctx.fillStyle = pt.labelBg;
        ctx.strokeStyle = pt.tick;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(bx, by, tw + 16, 8 + lines.length * 22, 4);
        else ctx.rect(bx, by, tw + 16, 8 + lines.length * 22);
        ctx.fill();
        ctx.stroke();
        lines.forEach((t, i) => {
          ctx.fillStyle = i === 0 ? pt.labelFg : colorRef.current(series[i - 1].lap_id);
          ctx.fillText(t, bx + 8, by + 22 + i * 22);
        });
      }
    };
    drawRef.current = draw;
    draw();
    const onMove = (e: MouseEvent) => {
      const rect = c.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (c.width / Math.max(rect.width, 1));
      const edges: number[] = data?.edges || [];
      const n = edges.length - 1;
      const padL = 72;
      const padR = 18;
      const plotW = c.width - padL - padR;
      if (n < 1 || plotW <= 0) return;
      const i = Math.floor(((x - padL) / plotW) * n);
      const next = i >= 0 && i < n ? i : null;
      if (next !== hoverRef.current) {
        hoverRef.current = next;
        setHoverBin(next);
        draw();
      }
    };
    const onLeave = () => {
      hoverRef.current = null;
      setHoverBin(null);
      draw();
    };
    c.addEventListener("mousemove", onMove);
    c.addEventListener("mouseleave", onLeave);
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(c);
    return () => {
      ro.disconnect();
      c.removeEventListener("mousemove", onMove);
      c.removeEventListener("mouseleave", onLeave);
    };
  }, [data, mode, ch, chMeta, shown, nativeU, dispU, laps, theme]);

  const thrNum = threshold === "" ? null : Number(threshold);
  const unit = dispU;

  return (
    <div className="page hist-page" data-export-root>
      <p className="muted hist-blurb">
        Share of lap time at each value — not sample counts, so you are not overweighting slow parts of the track.
        Use Overlay zoom, then clip to that window, to compare a corner. Gate (top bar) keeps only braking, full throttle, etc.
      </p>
      <div className="toolbar-inline hist-toolbar">
        <select value={ch} onChange={(e) => setCh(e.target.value)}>
          {channels.map((c) => {
            const s = displayChannel(c, pref);
            return (
            <option key={c.key} value={c.key}>{s.name}{s.unit ? ` (${s.unit})` : ""}</option>
            );
          })}
        </select>
        <label className="muted">
          Bins{" "}
          <input
            type="range"
            min={10}
            max={48}
            value={bins}
            onChange={(e) => setBins(Number(e.target.value))}
          />
          <span>{bins}</span>
        </label>
        <span className="hist-seg">
          <button className={mode === "pct" ? "primary" : "ghost"} onClick={() => setMode("pct")}>% of time</button>
          <button className={mode === "seconds" ? "primary" : "ghost"} onClick={() => setMode("seconds")}>Seconds</button>
        </span>
        {gates ? <span className="pill">gated</span> : null}
        <label className="muted" title="Limit to the distance window from Overlay drag-zoom">
          <input
            type="checkbox"
            checked={useZoom}
            disabled={!xRange}
            onChange={(e) => setUseZoom(e.target.checked)}
          />
          {xRange
            ? `Overlay window ${fmtNum(xRange[0], 0)}–${fmtNum(xRange[1], 0)} m`
            : "Overlay window (zoom Overlay first)"}
        </label>
        <label className="muted">
          Time ≥{" "}
          <input
            type="number"
            step="any"
            style={{ width: 72 }}
            placeholder="—"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value === "" ? "" : Number(e.target.value))}
          />
          {unit ? ` ${unit}` : ""}
        </label>
      </div>
      <div className="hist-legend">
        {(data?.series || []).map((s: any) => {
          const lap = laps.find((l) => l.id === s.lap_id);
          return (
            <span key={s.lap_id} className="hist-leg">
              <span className="dot" style={{ background: colorFor(s.lap_id) }} />
              L{lap?.number ?? s.lap_id}
            </span>
          );
        })}
      </div>
      <canvas ref={canvas} className="hist-canvas" />
      <div className="hist-stats">
        {(data?.series || []).map((s: any) => {
          const lap = laps.find((l) => l.id === s.lap_id);
          const st = s.stats || {};
          const above = st.above_s;
          const pctAbove = st.total_s ? (100 * (above ?? 0)) / st.total_s : 0;
          return (
            <div key={s.lap_id} className="hist-stat card">
              <div style={{ color: colorFor(s.lap_id), fontWeight: 600 }}>
                L{lap?.number ?? s.lap_id}{" "}
                <span className="muted">{fmtLap(lap?.time_ms)}</span>
              </div>
              <div className="muted">
                mean {fmtNum(convertMaybe(st.mean, nativeU, dispU), 1)} · median {fmtNum(convertMaybe(st.median, nativeU, dispU), 1)}
              </div>
              <div className="muted">
                min {fmtNum(convertMaybe(st.min, nativeU, dispU), 1)} · max {fmtNum(convertMaybe(st.max, nativeU, dispU), 1)}
              </div>
              {above != null && thrNum != null && (
                <div>
                  {above.toFixed(1)}s ({pctAbove.toFixed(0)}%) ≥ {fmtNum(thrNum, 0)} {unit}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {hoverBin != null && data?.edges && (
        <div className="muted" style={{ fontSize: 11 }}>
          Hover bin {fmtNum(data.edges[hoverBin], 1)} – {fmtNum(data.edges[hoverBin + 1], 1)} {unit}
        </div>
      )}
    </div>
  );
}

function trackKey(lap: Lap, sessions: Session[]) {
  const s = sessions.find((x) => x.id === lap.session_id);
  return s?.layout?.track_id ?? s?.layout?.track_name ?? "unknown";
}

function CoachTab({
  selected,
  laps,
  sessions,
  colorFor,
  view,
  onPatchSession,
}: {
  selected: number[];
  laps: Lap[];
  sessions: Session[];
  colorFor: (id: number) => string;
  view?: { mapColor: string; gatePreset: string; gates: DataGate[]; plotted: string[] };
  onPatchSession: (id: number, body: Partial<Session>) => Promise<void>;
}) {
  const [mode, setMode] = useState<"single" | "vs_fastest" | "vs_virtual" | "all">("vs_fastest");
  const [subjectId, setSubjectId] = useState<number | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; reason: string; provider: string; model: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [out, setOut] = useState<any>(null);
  const [showBrief, setShowBrief] = useState(false);

  const selectedLaps = laps.filter((l) => selected.includes(l.id));
  const anchor =
    laps.find((l) => l.id === subjectId && selected.includes(l.id)) ||
    selectedLaps.find((l) => l.kind === "valid") ||
    selectedLaps[0];
  const tk = anchor ? trackKey(anchor, sessions) : null;
  const onTrack = selectedLaps.filter((l) => !tk || trackKey(l, sessions) === tk);
  const flying = onTrack.filter((l) => l.kind === "valid");
  const pool = flying.length ? flying : onTrack;
  const fastest = [...pool].sort((a, b) => a.time_ms - b.time_ms)[0];

  useEffect(() => {
    api.coachStatus().then(setStatus).catch(() => setStatus({ ok: false, reason: "Coach API unreachable", provider: "", model: "" }));
  }, []);

  useEffect(() => {
    if (subjectId && pool.some((l) => l.id === subjectId)) return;
    const second = pool.find((l) => fastest && l.id !== fastest.id);
    setSubjectId((mode === "single" ? fastest?.id : second?.id || fastest?.id) ?? null);
  }, [pool.map((l) => l.id).join(","), mode]);

  async function generate(force = false) {
    if (!selected.length) return;
    setBusy(true);
    setErr("");
    try {
      const res = await api.coach({
        mode,
        lap_ids: onTrack.map((l) => l.id),
        subject_lap_id: subjectId,
        force,
        view: view
          ? {
              map_color: view.mapColor,
              gate_preset: view.gatePreset,
              gates: view.gates,
              plotted: view.plotted,
            }
          : undefined,
      });
      setOut(res);
    } catch (e: any) {
      const name = e?.name || "";
      setErr(
        name === "TimeoutError" || name === "AbortError"
          ? "Coach timed out waiting for Grok. Try fewer laps, or run again."
          : e.message || String(e)
      );
    } finally {
      setBusy(false);
    }
  }

  const report = out?.report;
  const subject = laps.find((l) => l.id === subjectId);

  return (
    <div className="page coach-page">
      <p className="muted hist-blurb">
        The coach sees a compact briefing — sectors, loss windows, throttle/brake/speed/G in those windows, your log sheet, and what you are looking at (rainbow map and data gates). Not the raw CSV.
        {status?.provider === "xai"
          ? " It calls the xAI Grok API (not grok.com chat)."
          : " It does not use grok.com."}{" "}
        {status?.ok ? `Model: ${status.provider} / ${status.model}` : status?.reason || ""}
      </p>
      {!status?.ok && status && (
        <div className="notice warn">{status.reason}</div>
      )}
      <div className="toolbar-inline hist-toolbar">
        <span className="hist-seg">
          {([
            ["vs_fastest", "vs fastest selected"],
            ["vs_virtual", "vs virtual best"],
            ["single", "single lap"],
            ["all", "all selected"],
          ] as const).map(([k, label]) => (
            <button key={k} className={mode === k ? "primary" : "ghost"} onClick={() => setMode(k)}>
              {label}
            </button>
          ))}
        </span>
        {mode !== "all" && (
          <label className="muted">
            Subject{" "}
            <select value={subjectId ?? ""} onChange={(e) => setSubjectId(Number(e.target.value))}>
              {pool.map((l) => (
                <option key={l.id} value={l.id}>
                  L{l.number} {fmtLap(l.time_ms)} {fastest && l.id === fastest.id ? "(fastest)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="primary" disabled={busy || !status?.ok || !selected.length} onClick={() => generate(false)}>
          {busy ? "Coaching…" : "Generate"}
        </button>
        {busy && (
          <span className="muted">Grok is writing the debrief — usually 15–40s.</span>
        )}
        {out && (
          <button className="ghost" disabled={busy || !status?.ok} onClick={() => generate(true)}>
            Run again
          </button>
        )}
      </div>
      {err && <div className="err">{err}</div>}
      {selectedLaps.length > onTrack.length && (
        <div className="notice warn">
          Coach is limited to {sessions.find((s) => s.id === anchor?.session_id)?.layout?.track_name || "this track"}.
          Other selected tracks were left out.
        </div>
      )}
      <div className="coach-notes-block">
        {sessions
          .filter((s) => onTrack.some((l) => l.session_id === s.id))
          .map((s) => (
            <div key={s.id} className="card" style={{ marginBottom: 8 }}>
              <div className="muted" style={{ marginBottom: 4 }}>
                {s.layout?.track_name || "Session"} · {s.filename.replace(/\.csv$/i, "")}
              </div>
              <LogSheetForm
                sheet={s.log_sheet}
                notes={s.notes}
                copyFrom={sessions.find((o) => o.id !== s.id && o.layout_id === s.layout_id && sheetFilled(o.log_sheet))?.log_sheet}
                onSaveSheet={(log_sheet) => onPatchSession(s.id, { log_sheet })}
                onSaveNotes={(notes) => onPatchSession(s.id, { notes })}
              />
            </div>
          ))}
      </div>
      {out?.cached && <div className="muted">Cached report (same laps, notes, and mode). Use Run again to refresh.</div>}
      {report && (
        <div className="coach-report">
          <h2>{report.headline || "Coach notes"}</h2>
          {subject && mode !== "all" && (
            <div className="muted" style={{ marginBottom: 10 }}>
              <span className="dot" style={{ background: colorFor(subject.id), display: "inline-block", marginRight: 6 }} />
              Subject L{subject.number} {fmtLap(subject.time_ms)}
              {fastest && subject.id !== fastest.id ? ` vs L${fastest.number} ${fmtLap(fastest.time_ms)}` : ""}
            </div>
          )}
          {report.summary && <p className="coach-summary">{report.summary}</p>}
          <ol className="coach-priorities">
            {(report.priorities || []).map((p: any, i: number) => (
              <li key={i} className="card">
                <div className="coach-where">
                  {p.where}
                  {p.loss_s != null && <span className="pill warn">{Number(p.loss_s) > 0 ? `+${Number(p.loss_s).toFixed(2)}s` : `${Number(p.loss_s).toFixed(2)}s`}</span>}
                </div>
                {p.diagnosis && (
                  <p>
                    <b>What the data shows. </b>
                    {p.diagnosis}
                  </p>
                )}
                <p>
                  <b>Next session. </b>
                  {p.do}
                </p>
                {p.why && (
                  <p className="muted">
                    <b>Why this first. </b>
                    {p.why}
                  </p>
                )}
                {p.evidence && !p.diagnosis && <div className="muted">{p.evidence}</div>}
              </li>
            ))}
          </ol>
          {!!(report.session_plan || []).length && (
            <>
              <h3>Next-session plan</h3>
              <ol className="coach-plan">
                {report.session_plan.map((t: string, i: number) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
            </>
          )}
          {!!(report.leave_alone || []).length && (
            <>
              <h3>Leave this alone</h3>
              <ul>
                {report.leave_alone.map((t: any, i: number) => (
                  <li key={i}>{typeof t === "string" ? t : [t.where, t.why].filter(Boolean).join(" — ")}</li>
                ))}
              </ul>
            </>
          )}
          {!!(report.caveats || []).length && (
            <>
              <h3>Caveats</h3>
              <ul className="muted">
                {report.caveats.map((t: string, i: number) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          )}
          <button className="ghost" onClick={() => setShowBrief((s) => !s)}>
            {showBrief ? "Hide data sent to the model" : "Show data sent to the model"}
          </button>
          {showBrief && (
            <pre className="coach-brief">{JSON.stringify(out.briefing, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

type AfrCell = { ix: number; iy: number; rpm0: number; rpm1: number; tps0: number; tps1: number; afr: number | null; n: number; delta?: number | null };

function lerpRgb(a: number[], b: number[], t: number): string {
  const u = Math.max(0, Math.min(1, t));
  const r = Math.round(a[0] + (b[0] - a[0]) * u);
  const g = Math.round(a[1] + (b[1] - a[1]) * u);
  const bl = Math.round(a[2] + (b[2] - a[2]) * u);
  return `rgb(${r},${g},${bl})`;
}

function afrFill(afr: number, rich: number, stoich: number, lean: number): string {
  const Y = [255, 224, 102];
  const G = [63, 185, 80];
  const R = [248, 81, 73];
  if (afr <= stoich) {
    const t = (afr - rich) / (stoich - rich || 1);
    return lerpRgb(Y, G, t);
  }
  const t = (afr - stoich) / (lean - stoich || 1);
  return lerpRgb(G, R, t);
}

function deltaFill(d: number, span: number): string {
  const B = [88, 166, 255];
  const Z = [139, 148, 158];
  const R = [248, 81, 73];
  const t = Math.max(-1, Math.min(1, d / (span || 0.3)));
  return t < 0 ? lerpRgb(Z, B, -t) : lerpRgb(Z, R, t);
}

function AfrMapTab({
  selected,
  laps,
  colorFor,
  refId,
  xRange,
  gates,
}: {
  selected: number[];
  laps: Lap[];
  colorFor: (id: number) => string;
  refId: number | null;
  xRange: [number, number] | null;
  gates?: string;
}) {
  const [data, setData] = useState<any>(null);
  const [view, setView] = useState<"combined" | "laps" | "delta">("combined");
  const [minN, setMinN] = useState(3);
  const [hover, setHover] = useState<AfrCell | null>(null);
  const [useZoom, setUseZoom] = useState(false);
  const windowed = useZoom && xRange != null;

  useEffect(() => {
    if (!selected.length) {
      setData(null);
      return;
    }
    const opts: { gates?: string; distMin?: number; distMax?: number; refLapId?: number | null } = {};
    if (gates) opts.gates = gates;
    if (windowed && xRange) {
      opts.distMin = xRange[0];
      opts.distMax = xRange[1];
    }
    if (refId) opts.refLapId = refId;
    api.afrMap(selected, opts).then(setData).catch(() => setData(null));
  }, [selected.join(","), gates, windowed, xRange?.[0], xRange?.[1], refId]);

  const refLap =
    laps.find((l) => l.id === refId && selected.includes(l.id)) ||
    [...laps.filter((l) => selected.includes(l.id) && l.kind === "valid")].sort((a, b) => a.time_ms - b.time_ms)[0] ||
    null;
  const refSeries = (data?.series || []).find((s: any) => s.lap_id === refLap?.id) || null;
  const rich = data?.rich ?? 12.5;
  const stoich = data?.stoich ?? 14.7;
  const lean = data?.lean ?? 16.0;
  const unit = data?.unit || "AFR";
  const missing = data?.missing || [];

  useEffect(() => {
    if (view === "delta" && selected.length < 2) setView("combined");
  }, [view, selected.length]);

  const deltaGrid = useMemo(() => {
    if (!refSeries || !data?.combined) return null;
    const others = (data.series || []).filter((s: any) => s.lap_id !== refSeries.lap_id);
    if (!others.length) return null;
    const ny = data.y_edges.length - 1;
    const nx = data.x_edges.length - 1;
    const mean: (number | null)[][] = [];
    const count: number[][] = [];
    for (let iy = 0; iy < ny; iy++) {
      const mRow: (number | null)[] = [];
      const cRow: number[] = [];
      for (let ix = 0; ix < nx; ix++) {
        let tot = 0;
        let n = 0;
        for (const s of others) {
          const c = s.count?.[iy]?.[ix] || 0;
          const v = s.mean?.[iy]?.[ix];
          if (c > 0 && v != null) {
            tot += v * c;
            n += c;
          }
        }
        const rN = refSeries.count?.[iy]?.[ix] || 0;
        const rV = refSeries.mean?.[iy]?.[ix];
        if (n >= minN && rN >= minN && rV != null) {
          mRow.push(tot / n - rV);
          cRow.push(n);
        } else {
          mRow.push(null);
          cRow.push(0);
        }
      }
      mean.push(mRow);
      count.push(cRow);
    }
    return { mean, count };
  }, [data, refSeries, minN]);

  if (!selected.length) return <div className="page muted">Select laps…</div>;
  if (missing.includes("afr") && !data?.combined) {
    return (
      <div className="page">
        <p>No AFR channel in these logs. Gauge.S needs <code>wbo (AFR)</code>.</p>
      </div>
    );
  }

  const maps =
    view === "laps"
      ? (data?.series || []).map((s: any) => ({
          key: s.lap_id,
          title: `L${laps.find((l) => l.id === s.lap_id)?.number ?? s.lap_id}`,
          color: colorFor(s.lap_id),
          grid: s,
          mode: "afr" as const,
        }))
      : view === "delta" && deltaGrid
        ? [
            {
              key: "delta",
              title: `Δ vs L${refLap?.number ?? "ref"} (negative = richer)`,
              color: "var(--purple)",
              grid: deltaGrid,
              mode: "delta" as const,
            },
          ]
        : [
            {
              key: "combined",
              title: selected.length > 1 ? "All selected laps" : `L${laps.find((l) => l.id === selected[0])?.number ?? ""}`,
              color: "var(--text)",
              grid: data?.combined,
              mode: "afr" as const,
            },
          ];

  return (
    <div className="page afr-page" data-export-root>
      <p className="muted afr-blurb">
        Mean {unit} in each RPM × throttle cell. Yellow = rich, green ≈ {fmtNum(stoich, unit === "λ" ? 2 : 1)} stoich, red = lean.
        Empty cells were never visited. Full-throttle gate turns this into a WOT mixture map.
      </p>
      <div className="toolbar-inline hist-toolbar">
        <span className="hist-seg">
          {(["combined", "laps", "delta"] as const).map((v) => (
            <button
              key={v}
              className={view === v ? "primary" : "ghost"}
              onClick={() => setView(v)}
              disabled={v === "delta" && !deltaGrid}
            >
              {v === "combined" ? "Combined" : v === "laps" ? "Per lap" : "Δ vs ref"}
            </button>
          ))}
        </span>
        <label>
          min samples
          <select className="kind-select" value={minN} onChange={(e) => setMinN(Number(e.target.value))}>
            {[1, 3, 8, 15].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        {xRange && (
          <label>
            <input type="checkbox" checked={useZoom} onChange={(e) => setUseZoom(e.target.checked)} />
            overlay zoom
          </label>
        )}
        {data?.combined?.n != null && (
          <span className="muted">
            {data.combined.n} samples · mean {fmtNum(data.combined.z_mean, unit === "λ" ? 2 : 2)} {unit}
          </span>
        )}
      </div>
      <div className={`afr-maps${view === "laps" ? " multi" : ""}`}>
        {maps.map((m: any) => (
          <div key={m.key} className="afr-map-card">
            <div className="muted" style={{ color: m.color, fontWeight: 600, marginBottom: 4 }}>
              {m.title}
            </div>
            <AfrHeatmap
              xEdges={data?.x_edges || []}
              yEdges={data?.y_edges || []}
              mean={m.grid?.mean}
              count={m.grid?.count}
              minN={minN}
              mode={m.mode}
              rich={rich}
              stoich={stoich}
              lean={lean}
              unit={unit}
              hover={hover}
              onHover={setHover}
            />
          </div>
        ))}
      </div>
      {hover && (
        <div className="afr-hover muted">
          {fmtNum(hover.rpm0, 0)}–{fmtNum(hover.rpm1, 0)} rpm · {fmtNum(hover.tps0, 0)}–{fmtNum(hover.tps1, 0)}% TPS
          {" · "}
          {hover.afr == null
            ? "no samples"
            : view === "delta"
              ? `${hover.afr > 0 ? "+" : ""}${fmtNum(hover.afr, 2)} ${unit} vs ref`
              : `${fmtNum(hover.afr, 2)} ${unit}`}
          {hover.n > 0 && ` · ${hover.n} samples`}
        </div>
      )}
    </div>
  );
}

function AfrHeatmap({
  xEdges,
  yEdges,
  mean,
  count,
  minN,
  mode,
  rich,
  stoich,
  lean,
  unit,
  hover,
  onHover,
}: {
  xEdges: number[];
  yEdges: number[];
  mean?: (number | null)[][];
  count?: number[][];
  minN: number;
  mode: "afr" | "delta";
  rich: number;
  stoich: number;
  lean: number;
  unit: string;
  hover: AfrCell | null;
  onHover: (c: AfrCell | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const nx = Math.max(0, xEdges.length - 1);
  const ny = Math.max(0, yEdges.length - 1);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const el = canvas.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setTick((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const pt = plotTheme();
    const w = (c.width = Math.max(2, c.clientWidth * 2));
    const h = (c.height = Math.max(2, c.clientHeight * 2));
    ctx.fillStyle = pt.bg;
    ctx.fillRect(0, 0, w, h);
    if (nx < 1 || ny < 1 || !mean) {
      ctx.fillStyle = pt.muted;
      ctx.font = "22px sans-serif";
      ctx.fillText("No AFR map for this selection", 24, h / 2);
      return;
    }
    const padL = 72;
    const padR = 88;
    const padT = 12;
    const padB = 44;
    const gw = w - padL - padR;
    const gh = h - padT - padB;
    const cw = gw / nx;
    const ch = gh / ny;
    const span = mode === "delta" ? 0.4 : 1;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const n = count?.[iy]?.[ix] || 0;
        const v = mean?.[iy]?.[ix];
        const x = padL + ix * cw;
        const y = padT + (ny - 1 - iy) * ch;
        if (v == null || n < minN) {
          ctx.fillStyle = pt.tick;
          ctx.globalAlpha = 0.25;
          ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
          ctx.globalAlpha = 1;
          continue;
        }
        ctx.fillStyle = mode === "delta" ? deltaFill(v, span) : afrFill(v, rich, stoich, lean);
        const alpha = Math.max(0.45, Math.min(1, n / 12));
        ctx.globalAlpha = alpha;
        ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        ctx.globalAlpha = 1;
      }
    }
    const hv = hoverRef.current;
    if (hv && hv.ix >= 0 && hv.iy >= 0) {
      ctx.strokeStyle = pt.text;
      ctx.lineWidth = 2;
      ctx.strokeRect(padL + hv.ix * cw + 1, padT + (ny - 1 - hv.iy) * ch + 1, cw - 2, ch - 2);
    }
    ctx.fillStyle = pt.axis;
    ctx.font = "18px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xStep = nx > 10 ? 2 : 1;
    for (let i = 0; i < xEdges.length; i += xStep) {
      ctx.fillText(String(Math.round(xEdges[i])), padL + (i / nx) * gw, padT + gh + 8);
    }
    ctx.fillText("rpm", padL + gw / 2, padT + gh + 26);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i < yEdges.length; i++) {
      ctx.fillText(String(Math.round(yEdges[i])), padL - 8, padT + gh - (i / ny) * gh);
    }
    ctx.save();
    ctx.translate(18, padT + gh / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("throttle %", 0, 0);
    ctx.restore();

    const lgX = w - padR + 18;
    const lgY = padT;
    const lgH = gh;
    const lgW = 16;
    for (let p = 0; p < lgH; p++) {
      const t = 1 - p / lgH;
      if (mode === "delta") {
        const d = (t - 0.5) * 2 * span;
        ctx.fillStyle = deltaFill(d, span);
      } else {
        const afr = rich + t * (lean - rich);
        ctx.fillStyle = afrFill(afr, rich, stoich, lean);
      }
      ctx.fillRect(lgX, lgY + p, lgW, 2);
    }
    ctx.fillStyle = pt.axis;
    ctx.textAlign = "left";
    ctx.font = "16px sans-serif";
    if (mode === "delta") {
      ctx.textBaseline = "top";
      ctx.fillText(`+${span.toFixed(1)} lean`, lgX + 22, lgY);
      ctx.textBaseline = "middle";
      ctx.fillText("0", lgX + 22, lgY + lgH / 2);
      ctx.textBaseline = "bottom";
      ctx.fillText(`−${span.toFixed(1)} rich`, lgX + 22, lgY + lgH);
    } else {
      ctx.textBaseline = "top";
      ctx.fillText(`${fmtNum(lean, unit === "λ" ? 2 : 1)} lean`, lgX + 22, lgY);
      ctx.textBaseline = "middle";
      ctx.fillText(`${fmtNum(stoich, unit === "λ" ? 2 : 1)}`, lgX + 22, lgY + lgH * ((stoich - rich) / (lean - rich || 1)));
      ctx.textBaseline = "bottom";
      ctx.fillText(`${fmtNum(rich, unit === "λ" ? 2 : 1)} rich`, lgX + 22, lgY + lgH);
    }
  }, [xEdges, yEdges, mean, count, minN, mode, rich, stoich, lean, unit, hover, theme, nx, ny, tick]);

  function cellAt(ev: ReactPointerEvent<HTMLCanvasElement>): AfrCell | null {
    const c = canvas.current;
    if (!c || nx < 1 || ny < 1) return null;
    const r = c.getBoundingClientRect();
    const w = c.clientWidth;
    const h = c.clientHeight;
    const padL = 72 / 2;
    const padR = 88 / 2;
    const padT = 12 / 2;
    const padB = 44 / 2;
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    const gw = w - padL - padR;
    const gh = h - padT - padB;
    const ix = Math.floor(((x - padL) / gw) * nx);
    const iyFromTop = Math.floor(((y - padT) / gh) * ny);
    const iy = ny - 1 - iyFromTop;
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return null;
    const n = count?.[iy]?.[ix] || 0;
    const v = mean?.[iy]?.[ix] ?? null;
    return {
      ix,
      iy,
      rpm0: xEdges[ix],
      rpm1: xEdges[ix + 1],
      tps0: yEdges[iy],
      tps1: yEdges[iy + 1],
      afr: n >= minN ? v : null,
      n,
    };
  }

  return (
    <canvas
      ref={canvas}
      className="afr-canvas"
      onPointerMove={(e) => onHover(cellAt(e))}
      onPointerLeave={() => onHover(null)}
    />
  );
}

function ReportTab({ selected, channels, gates }: { selected: number[]; channels: Channel[]; gates?: string }) {
  const pref = useUnitPref();
  const keys = ["gps_speed_mph", "rpm", "tps", "brake", "gps_long_g", "gps_lat_g", "oil_temp", "coolant", "afr", "battery"];
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    if (selected.length) api.report(selected, keys, { gates: gates || undefined }).then(setRows as any);
  }, [selected.join(","), gates]);
  const gated = Boolean(gates);
  return (
    <div className="page" data-export-root>
      {gated && (
        <p className="muted" style={{ margin: "0 0 8px" }}>
          Stats use only samples that match the gate
          {rows[0]?.gate_frac != null ? ` (${Math.round(rows[0].gate_frac * 100)}% of L${rows[0].number})` : ""}.
        </p>
      )}
      <table className="card">
        <thead>
          <tr>
            <th>Lap</th>
            {keys.map((k) => {
              const ch = channels.find((c) => c.key === k);
              const shown = ch ? displayChannel(ch, pref) : undefined;
              return (
              <th key={k} colSpan={3}>{shown?.name || ch?.name || k}{shown?.unit ? ` (${shown.unit})` : ""}</th>
              );
            })}
          </tr>
          <tr>
            <th />
            {keys.map((k) => (
              <>
                <th key={k + "n"}>min</th>
                <th key={k + "x"}>max</th>
                <th key={k + "a"}>avg</th>
              </>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>L{r.number}</td>
              {keys.map((k) => {
                const s = r.channels?.[k];
                const ch = channels.find((c) => c.key === k);
                const shown = ch ? displayChannel(ch, pref) : undefined;
                const toD = (v: number | null | undefined) => convertMaybe(v ?? null, ch?.unit || "", shown?.unit || "");
                return (
                  <>
                    <td key={k + "n"}>{s ? fmtNum(toD(s.min)) : "—"}</td>
                    <td key={k + "x"}>{s ? fmtNum(toD(s.max)) : "—"}</td>
                    <td key={k + "a"}>{s ? fmtNum(toD(s.avg)) : "—"}</td>
                  </>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrackTab({
  layout,
  sessions,
  mapData,
  colorFor,
  onSaved,
}: {
  layout: Layout;
  sessions: Session[];
  mapData: any[];
  colorFor: (id: number) => string;
  onSaved: () => void | Promise<void>;
}) {
  const session = sessions[0];
  const [gate, setGate] = useState<Gate | null>(layout.sf_gate);
  const [finish, setFinish] = useState<Gate | null>(layout.finish_gate);
  const [timingMode, setTimingMode] = useState<"loop" | "stage">(layout.timing_mode === "stage" ? "stage" : "loop");
  const [sectors, setSectors] = useState<Gate[]>(layout.sectors || []);
  const [selectedSplit, setSelectedSplit] = useState<number | null>(null);
  const [placingKind, setPlacingKind] = useState<"split" | "start" | "finish" | null>(null);
  const [equalN, setEqualN] = useState(3);
  const [msg, setMsg] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "recalc" | "saved">("idle");
  const [trackLayouts, setTrackLayouts] = useState<Layout[]>([]);
  const placingRef = useRef<"split" | "start" | "finish" | null>(null);
  const stage = timingMode === "stage";
  useEffect(() => {
    setGate(layout.sf_gate);
    setFinish(layout.finish_gate);
    setTimingMode(layout.timing_mode === "stage" ? "stage" : "loop");
    setSectors(layout.sectors || []);
    setSelectedSplit(null);
    placingRef.current = null;
    setPlacingKind(null);
  }, [layout.id]);
  useEffect(() => {
    let cancel = false;
    api.tracks()
      .then((ts) => {
        if (cancel) return;
        const t = ts.find((x) => x.layouts.some((l) => l.id === layout.id));
        setTrackLayouts(t?.layouts || []);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [layout.id]);
  useEffect(() => {
    if (!placingKind) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      placingRef.current = null;
      setPlacingKind(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placingKind]);

  function startPlacing(kind: "split" | "start" | "finish") {
    if (placingKind === kind) {
      placingRef.current = null;
      setPlacingKind(null);
      return;
    }
    placingRef.current = kind;
    setPlacingKind(kind);
    setMsg("");
  }

  function applySectors(next: Gate[], keep?: Gate) {
    const sorted = sortSectors(mapData, next);
    setSectors(sorted);
    if (keep) {
      const mid = gateMid(keep);
      const idx = sorted.findIndex((s) => {
        const m = gateMid(s);
        return Math.abs(m.lat - mid.lat) < 1e-7 && Math.abs(m.lon - mid.lon) < 1e-7;
      });
      setSelectedSplit(idx >= 0 ? idx : null);
    }
  }

  function addSplit(g: Gate) {
    if (sectors.length >= MAX_SPLITS) {
      setMsg(`Max ${MAX_SPLITS + 1} sectors (${MAX_SPLITS} splits).`);
      return;
    }
    if (splitTooClose(mapData, g, sectors)) {
      setMsg("Split is too close to S/F or another split. Drop it further along the line.");
      return;
    }
    applySectors([...sectors, g], g);
    setMsg("");
  }

  function onPlace(g: Gate) {
    const kind = placingRef.current;
    placingRef.current = null;
    setPlacingKind(null);
    if (kind === "start") {
      setGate(g);
      setMsg(stage ? "Start (A) placed. Save to retime." : "S/F placed. Save to rewrite laps.");
      return;
    }
    if (kind === "finish") {
      setFinish(g);
      setMsg("Finish (B) placed. Save to retime.");
      return;
    }
    if (kind === "split") addSplit(g);
  }

  function removeSplit(i: number) {
    applySectors(sectors.filter((_, j) => j !== i));
    setSelectedSplit(null);
  }

  async function propose() {
    if (stage) {
      const ends = proposeEndsFromTraces(mapData);
      if (!ends) {
        setMsg("Need GPS on the map to propose A and B.");
        return;
      }
      setGate(ends.start);
      setFinish(ends.finish);
      setMsg("Proposed A and B from the ends of this GPS. Drag onto the bridge and gantry (or stage start/finish), then Save.");
      return;
    }
    const g: any = await api.proposeSf(layout.id, session.id);
    setGate(g.sf_gate);
    setMsg("Proposed start/finish from this GPS. Nothing is saved yet — drag it if needed, then Save to rewrite laps.");
  }

  async function switchLayout(id: number) {
    if (id === layout.id || saveState === "saving" || saveState === "recalc") return;
    setSaveState("recalc");
    setMsg("Switching layout…");
    try {
      await api.patchSession(session.id, { layout_id: id });
      await api.reprocess(session.id);
      await onSaved();
      setMsg("Layout switched. Place gates if this is point-to-point, then Save + reprocess.");
      setSaveState("idle");
    } catch (e: any) {
      setSaveState("idle");
      setMsg(e.message || String(e));
    }
  }

  async function save() {
    if (saveState === "saving" || saveState === "recalc") return;
    if (!gate) {
      setMsg(stage ? "Place start (A) first." : "Place S/F first.");
      return;
    }
    if (stage && !finish) {
      setMsg("Place finish (B) first.");
      return;
    }
    setSaveState("saving");
    setMsg("Saving track…");
    try {
      const saved: any = await api.patchLayout(layout.id, {
        sf_gate: cleanGate(gate),
        finish_gate: stage && finish ? cleanGate(finish) : null,
        timing_mode: timingMode,
        sectors: sectors.map((g) => cleanGate(g)),
      });
      const ids: number[] = Array.isArray(saved?.session_ids) && saved.session_ids.length
        ? saved.session_ids.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
        : sessions.map((s) => s.id);
      const prefer = new Set(sessions.map((s) => s.id));
      const ordered = [...ids.filter((id) => prefer.has(id)), ...ids.filter((id) => !prefer.has(id))];
      setSaveState("recalc");
      let failed = 0;
      let refreshed = false;
      for (let i = 0; i < ordered.length; i++) {
        setMsg(`Recalculating laps (${i + 1} of ${ordered.length})…`);
        try {
          await api.reprocess(ordered[i]);
        } catch {
          failed += 1;
        }
        if (!refreshed && prefer.has(ordered[i])) {
          await onSaved();
          refreshed = true;
        }
      }
      if (!refreshed) await onSaved();
      const nsec = sectors.length + 1;
      const modeBit = stage ? "A→B" : "loop S/F";
      const splitBit = sectors.length
        ? `${sectors.length} split${sectors.length === 1 ? "" : "s"} (${nsec} sectors)`
        : "equal thirds";
      setMsg(
        failed
          ? `Saved ${modeBit}, ${splitBit}. Retimed ${ordered.length - failed} of ${ordered.length} sessions (${failed} failed).`
          : `Saved ${modeBit}, ${splitBit}. Retimed ${ordered.length} session${ordered.length === 1 ? "" : "s"}.`
      );
      setSaveState("saved");
      window.setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
    } catch (e: any) {
      setSaveState("idle");
      setMsg(e.message || String(e));
    }
  }

  const turnN = layout.turns?.count;
  const nsec = sectors.length ? sectors.length + 1 : 3;

  const canSave = stage ? !!(gate && finish) : !!gate;
  const placeHint =
    placingKind === "start"
      ? stage
        ? "Click the GPS line to place start (A). Esc cancels."
        : "Click the GPS line to place S/F. Esc cancels."
      : placingKind === "finish"
        ? "Click the GPS line to place finish (B). Esc cancels."
        : placingKind === "split"
          ? "Click the GPS line to place a split. Esc cancels."
          : "";

  return (
    <div className="page" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 12, height: "100%" }}>
      <div className="panel" style={{ height: "100%" }}>
        <h3>
          {layout.track_name} · {layout.name}
        </h3>
        <TrackMap
          data={mapData}
          layout={{ ...layout, sf_gate: gate, finish_gate: finish, timing_mode: timingMode, sectors }}
          selected={mapData.map((d: any) => d.lap_id)}
          colorFor={colorFor}
          cursorDist={0}
          onCursor={() => {}}
          onEditGate={setGate}
          onEditFinish={setFinish}
          placingKind={placingKind}
          selectedSplit={selectedSplit}
          onEditSectors={(next) => {
            let moved: Gate | undefined;
            if (next.length === sectors.length) {
              moved = next.find((g, i) => {
                const cur = sectors[i];
                if (!cur) return true;
                const a = gateMid(g);
                const b = gateMid(cur);
                return Math.abs(a.lat - b.lat) > 1e-7 || Math.abs(a.lon - b.lon) > 1e-7;
              });
            }
            applySectors(next, moved);
          }}
          onSelectSplit={setSelectedSplit}
          onPlace={onPlace}
        />
      </div>
      <div className="card track-editor">
        <p className="muted">
          {stage
            ? "White handle is start (A), orange is finish (B). Time is A then the next B — rally stages, hillclimbs, Nordschleife bridge-to-gantry. Gold handles are intermediate splits."
            : "White handle is S/F. Gold handles are sector splits (end of S1, S2, …). Drag along the GPS line; they snap and stay perpendicular."}{" "}
          Save rewrites every session at this layout.
        </p>
        {layout.venue === "User" && (
          <label className="muted" style={{ display: "block", marginTop: 8 }}>
            Track name
            <input
              style={{ marginLeft: 8 }}
              defaultValue={layout.track_name || ""}
              key={layout.track_name || layout.id}
              onBlur={async (e) => {
                const name = e.target.value.trim();
                if (!name || name === layout.track_name) return;
                try {
                  await api.patchLayout(layout.id, { track_name: name });
                  await onSaved();
                  setMsg(`Renamed to ${name}.`);
                } catch (ex: any) {
                  setMsg(ex.message || String(ex));
                }
              }}
            />
          </label>
        )}
        {layout.venue === "User" && layout.sf_gate?.source !== "user" && (
          <p className="err">This track was created from the log. Confirm start/finish, then Save.</p>
        )}
        {trackLayouts.length > 1 && (
          <label className="muted" style={{ display: "block", marginTop: 8 }}>
            Layout
            <select
              className="kind-select"
              style={{ marginLeft: 8 }}
              value={layout.id}
              onChange={(e) => switchLayout(Number(e.target.value))}
            >
              {trackLayouts.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {(l.timing_mode || "loop") === "stage" ? " (A→B)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="toolbar-inline" style={{ margin: "10px 0" }}>
          <button
            className={timingMode === "loop" ? "primary" : undefined}
            onClick={() => setTimingMode("loop")}
          >
            Loop S/F
          </button>
          <button
            className={timingMode === "stage" ? "primary" : undefined}
            onClick={() => setTimingMode("stage")}
          >
            Point-to-point A→B
          </button>
        </div>
        <div className="toolbar-inline" style={{ margin: "10px 0" }}>
          <button onClick={propose} disabled={!mapData.length && stage}>
            {stage ? "Propose A/B from GPS ends" : "Propose S/F from GPS"}
          </button>
          {stage && (
            <>
              <button className={placingKind === "start" ? "primary" : undefined} onClick={() => startPlacing("start")} disabled={!mapData.length}>
                {gate ? "Move A" : "Place A"}
              </button>
              <button className={placingKind === "finish" ? "primary" : undefined} onClick={() => startPlacing("finish")} disabled={!mapData.length}>
                {finish ? "Move B" : "Place B"}
              </button>
            </>
          )}
          {!stage && !gate && (
            <button className={placingKind === "start" ? "primary" : undefined} onClick={() => startPlacing("start")} disabled={!mapData.length}>
              Place S/F
            </button>
          )}
          <button
            className={saveState === "saved" ? "saved" : "primary"}
            onClick={save}
            disabled={!canSave || saveState === "saving" || saveState === "recalc"}
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "recalc"
                ? "Recalculating…"
                : saveState === "saved"
                  ? "Saved"
                  : "Save + reprocess"}
          </button>
        </div>
        <h4>Splits</h4>
        <p className="muted">
          {turnN ? `${turnN} turns on this layout. ` : ""}
          {sectors.length
            ? `${nsec} sectors from ${sectors.length} split${sectors.length === 1 ? "" : "s"}.`
            : "No splits stored — Save uses equal thirds."}{" "}
          Typical timing uses 3–6 sectors, placed on the straights.
        </p>
        {placeHint && <div className="notice">{placeHint}</div>}
        <div className="toolbar-inline" style={{ margin: "8px 0" }}>
          <button
            className={placingKind === "split" ? "primary" : undefined}
            onClick={() => {
              if (placingKind === "split") {
                startPlacing("split");
                return;
              }
              if (sectors.length >= MAX_SPLITS) {
                setMsg(`Max ${MAX_SPLITS + 1} sectors.`);
                return;
              }
              startPlacing("split");
            }}
            disabled={!mapData.length}
          >
            {placingKind === "split" ? "Cancel place" : "Add split"}
          </button>
          <select
            className="kind-select"
            value={equalN}
            onChange={(e) => setEqualN(Number(e.target.value))}
            title="Number of equal-distance sectors"
          >
            {[2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n} equal
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              const next = equalSectorGates(mapData, equalN);
              applySectors(next);
              setSelectedSplit(null);
              placingRef.current = null;
              setPlacingKind(null);
              setMsg(next.length ? `Placed ${next.length} equal split${next.length === 1 ? "" : "s"} (${equalN} sectors). Save to retime.` : "Need GPS on the map to place splits.");
            }}
            disabled={!mapData.length}
          >
            Place equal
          </button>
        </div>
        {sectors.length > 0 && (
          <ul className="split-editor-list">
            {sectors.map((_, i) => (
              <li
                key={i}
                className={selectedSplit === i ? "on" : ""}
                onClick={() => setSelectedSplit(i)}
              >
                <span>S{i + 1}</span>
                <button
                  className="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSplit(i);
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {sectors.length > 0 && (
          <button
            className="ghost"
            onClick={() => {
              setSectors([]);
              setSelectedSplit(null);
              setMsg("Cleared splits. Save to fall back to equal thirds.");
            }}
          >
            Clear splits
          </button>
        )}
        {msg && <div className={`notice${saveState === "saved" ? " ok" : ""}`}>{msg}</div>}
        <p className="muted" style={{ marginTop: 10 }}>
          Length {fmtNum(layout.length_m, 0)} m · {layout.direction}. Beacons are stored on the layout and reused for
          every session at this venue.
        </p>
      </div>
    </div>
  );
}
