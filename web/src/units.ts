import { createContext, useContext } from "react";
import type { Channel } from "./types";

export type UnitPref = "metric" | "imperial";

export const UNITS_KEY = "ta-units";

const CANON: Record<string, string> = {
  c: "°C",
  "°c": "°C",
  degc: "°C",
  celsius: "°C",
  f: "°F",
  "°f": "°F",
  degf: "°F",
  fahrenheit: "°F",
  psi: "psi",
  kpa: "kPa",
  bar: "bar",
  mph: "mph",
  "km/h": "km/h",
  kmh: "km/h",
  kph: "km/h",
};

const TO_METRIC: Record<string, string> = {
  "°F": "°C",
  "°C": "°C",
  psi: "bar",
  kPa: "bar",
  bar: "bar",
  mph: "km/h",
  "km/h": "km/h",
};

const TO_IMPERIAL: Record<string, string> = {
  "°C": "°F",
  "°F": "°F",
  bar: "psi",
  kPa: "psi",
  psi: "psi",
  "km/h": "mph",
  mph: "mph",
};

export function canonUnit(unit: string | null | undefined): string {
  if (!unit) return "";
  const t = unit.trim();
  return CANON[t.toLowerCase()] || t;
}

export function preferredUnit(native: string | null | undefined, pref: UnitPref): string {
  const n = canonUnit(native);
  if (!n) return native || "";
  const table = pref === "metric" ? TO_METRIC : TO_IMPERIAL;
  return table[n] || n;
}

export function convertValue(v: number, from: string, to: string): number {
  const a = canonUnit(from);
  const b = canonUnit(to);
  if (!a || !b || a === b) return v;
  if (a === "°F" && b === "°C") return (v - 32) * (5 / 9);
  if (a === "°C" && b === "°F") return v * (9 / 5) + 32;
  if (a === "mph" && b === "km/h") return v * 1.609344;
  if (a === "km/h" && b === "mph") return v * 0.621371;
  if (a === "psi" && b === "kPa") return v * 6.89476;
  if (a === "kPa" && b === "psi") return v / 6.89476;
  if (a === "psi" && b === "bar") return v * 0.0689476;
  if (a === "bar" && b === "psi") return v / 0.0689476;
  if (a === "kPa" && b === "bar") return v / 100;
  if (a === "bar" && b === "kPa") return v * 100;
  return v;
}

export function convertMaybe(v: number | null | undefined, from: string, to: string): number | null {
  if (v == null || Number.isNaN(Number(v))) return v ?? null;
  return convertValue(Number(v), from, to);
}

export function displayChannel(ch: Channel, pref: UnitPref): Channel {
  return { ...ch, unit: preferredUnit(ch.unit, pref) };
}

export function convertY(y: (number | null)[] | undefined, from: string, to: string): (number | null)[] | undefined {
  if (!y || canonUnit(from) === canonUnit(to)) return y;
  return y.map((v) => (v == null || Number.isNaN(Number(v)) ? v : convertValue(Number(v), from, to)));
}

/** Hide the GPS speed column that is just the other unit system. */
export function visibleChannels(channels: Channel[], pref: UnitPref): Channel[] {
  const keys = new Set(channels.map((c) => c.key));
  const hide = pref === "metric" ? "gps_speed_mph" : "gps_speed";
  const keep = pref === "metric" ? "gps_speed" : "gps_speed_mph";
  if (keys.has(hide) && keys.has(keep)) return channels.filter((c) => c.key !== hide);
  return channels;
}

export function remapSpeedKey(key: string, channels: Channel[], pref: UnitPref): string {
  const keys = new Set(channels.map((c) => c.key));
  if (pref === "metric" && key === "gps_speed_mph" && keys.has("gps_speed")) return "gps_speed";
  if (pref === "imperial" && key === "gps_speed" && keys.has("gps_speed_mph")) return "gps_speed_mph";
  return key;
}

export function inferPrefFromChannels(channels: Channel[]): UnitPref | null {
  const metric = new Set(["°C", "kPa", "bar", "km/h"]);
  const imperial = new Set(["°F", "psi", "mph"]);
  let m = 0;
  let i = 0;
  for (const c of channels) {
    const u = canonUnit(c.unit);
    if (metric.has(u)) m += 1;
    if (imperial.has(u)) i += 1;
  }
  if (m >= 2 && m > i) return "metric";
  if (i >= 2 && i > m) return "imperial";
  return null;
}

export function loadUnitPref(): UnitPref | null {
  try {
    const v = localStorage.getItem(UNITS_KEY);
    if (v === "metric" || v === "imperial") return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function convertScaleMap(
  scale: Record<string, { min: number | null; max: number | null }>,
  channels: Channel[],
  fromPref: UnitPref,
  toPref: UnitPref,
): Record<string, { min: number | null; max: number | null }> {
  if (fromPref === toPref) return scale;
  const out: Record<string, { min: number | null; max: number | null }> = { ...scale };
  for (const ch of channels) {
    const sc = out[ch.key];
    if (!sc) continue;
    const a = preferredUnit(ch.unit, fromPref);
    const b = preferredUnit(ch.unit, toPref);
    if (a === b) continue;
    out[ch.key] = {
      min: sc.min == null ? null : convertValue(sc.min, a, b),
      max: sc.max == null ? null : convertValue(sc.max, a, b),
    };
  }
  return out;
}

export const UnitPrefContext = createContext<UnitPref>("imperial");

export function useUnitPref(): UnitPref {
  return useContext(UnitPrefContext);
}
