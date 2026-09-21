import { useEffect, useRef, useState } from "react";
import type { LogSheet } from "./types";
import { convertMaybe, convertValue, loadUnitPref, preferredUnit, useUnitPref } from "./units";

const WEATHER = ["", "Dry", "Damp", "Wet", "Rain", "Cloudy", "Hot", "Cold"];
const WIND = ["", "Calm", "Light", "Windy"];
const TYRE_HEALTH = ["", "New", "Heat-cycled", "Used", "Worn", "Grained"];

function num(v: number | null | undefined): string {
  return v == null || Number.isNaN(Number(v)) ? "" : String(v);
}

function parseNum(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function shownNum(v: number | null | undefined, from: string, to: string): string {
  const n = convertMaybe(v, from, to);
  if (n == null || Number.isNaN(Number(n))) return "";
  return String(Math.round(Number(n) * 10) / 10);
}

export function sheetFilled(sheet?: LogSheet | null): boolean {
  if (!sheet) return false;
  return Object.values(sheet).some((v) => v != null && v !== "");
}

export default function LogSheetForm({
  sheet,
  notes,
  onSaveSheet,
  onSaveNotes,
  copyFrom,
  copyLabel = "Copy last at this track",
}: {
  sheet?: LogSheet | null;
  notes?: string;
  onSaveSheet: (next: LogSheet) => void | Promise<void>;
  onSaveNotes?: (notes: string) => void | Promise<void>;
  copyFrom?: LogSheet | null;
  copyLabel?: string;
}) {
  const storedPref = useUnitPref();
  const pref = loadUnitPref() || storedPref;
  const tempUnit = pref === "metric" ? "°C" : "°F";
  const pressUnit = preferredUnit("psi", pref);
  const [local, setLocal] = useState<LogSheet>(sheet || {});
  const [localNotes, setLocalNotes] = useState(notes || "");
  const localRef = useRef(local);
  localRef.current = local;

  useEffect(() => {
    setLocal(sheet || {});
  }, [JSON.stringify(sheet || {})]);
  useEffect(() => {
    setLocalNotes(notes || "");
  }, [notes]);

  function patch(partial: LogSheet) {
    const next = { ...localRef.current, ...partial };
    localRef.current = next;
    setLocal(next);
    return next;
  }

  function save(next?: LogSheet) {
    onSaveSheet(next || localRef.current);
  }

  return (
    <div className="log-sheet">
      <div className="log-sheet-head">
        <span className="muted">Log sheet</span>
        {copyFrom && sheetFilled(copyFrom) && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const next = { ...copyFrom };
              setLocal(next);
              save(next);
            }}
          >
            {copyLabel}
          </button>
        )}
      </div>
      <div className="sheet-grid">
        <label>
          Weather
          <select
            className="kind-select"
            value={local.weather || ""}
            onChange={(e) => save(patch({ weather: e.target.value }))}
          >
            {WEATHER.map((w) => (
              <option key={w || "none"} value={w}>{w || "—"}</option>
            ))}
          </select>
        </label>
        <label>
          Wind
          <select
            className="kind-select"
            value={local.wind || ""}
            onChange={(e) => save(patch({ wind: e.target.value }))}
          >
            {WIND.map((w) => (
              <option key={w || "none"} value={w}>{w || "—"}</option>
            ))}
          </select>
        </label>
        <label>
          Ambient {tempUnit}
          <input
            type="number"
            step="0.1"
            value={shownNum(local.ambient_f, "°F", tempUnit)}
            onChange={(e) => {
              const shown = parseNum(e.target.value);
              patch({ ambient_f: shown == null ? null : convertValue(shown, tempUnit, "°F") });
            }}
            onBlur={() => save()}
          />
        </label>
        <label>
          Track {tempUnit}
          <input
            type="number"
            step="0.1"
            value={shownNum(local.track_temp_f, "°F", tempUnit)}
            onChange={(e) => {
              const shown = parseNum(e.target.value);
              patch({ track_temp_f: shown == null ? null : convertValue(shown, tempUnit, "°F") });
            }}
            onBlur={() => save()}
          />
        </label>
        <label>
          Tyre set
          <input
            value={local.tyre_set || ""}
            placeholder="Set A, new Hoosiers…"
            onChange={(e) => patch({ tyre_set: e.target.value })}
            onBlur={() => save(local)}
          />
        </label>
        <label>
          Tyre health
          <select
            className="kind-select"
            value={local.tyre_health || ""}
            onChange={(e) => save(patch({ tyre_health: e.target.value }))}
          >
            {TYRE_HEALTH.map((w) => (
              <option key={w || "none"} value={w}>{w || "—"}</option>
            ))}
          </select>
        </label>
        <div className="wide">
          <div className="muted" style={{ marginBottom: 4 }}>Hot pressures ({pressUnit})</div>
          <div className="sheet-pressures">
            {([
              ["pressure_fl", "FL"],
              ["pressure_fr", "FR"],
              ["pressure_rl", "RL"],
              ["pressure_rr", "RR"],
            ] as const).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  step="0.1"
                  value={shownNum(local[key], "psi", pressUnit)}
                  onChange={(e) => {
                    const shown = parseNum(e.target.value);
                    patch({ [key]: shown == null ? null : convertValue(shown, pressUnit, "psi") });
                  }}
                  onBlur={() => save()}
                />
              </label>
            ))}
          </div>
        </div>
        <label>
          Fuel
          <input
            value={local.fuel || ""}
            placeholder="Full, ½ tank, 8 gal…"
            onChange={(e) => patch({ fuel: e.target.value })}
            onBlur={() => save(local)}
          />
        </label>
        <label>
          Wing / aero
          <input
            value={local.wing || ""}
            placeholder="6 holes, low wing…"
            onChange={(e) => patch({ wing: e.target.value })}
            onBlur={() => save(local)}
          />
        </label>
        <label className="wide">
          Setup
          <input
            value={local.setup || ""}
            placeholder="Bars, ride height, brake bias…"
            onChange={(e) => patch({ setup: e.target.value })}
            onBlur={() => save(local)}
          />
        </label>
        {onSaveNotes && (
          <label className="wide">
            Other notes
            <textarea
              className="session-notes"
              rows={3}
              placeholder="Anything else Coach should know…"
              value={localNotes}
              onChange={(e) => setLocalNotes(e.target.value)}
              onBlur={() => onSaveNotes(localNotes)}
            />
          </label>
        )}
      </div>
    </div>
  );
}
