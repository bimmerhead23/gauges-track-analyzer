export function fmtLap(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  const sign = ms < 0 ? "-" : "";
  const a = Math.abs(ms);
  const m = Math.floor(a / 60000);
  const s = Math.floor((a % 60000) / 1000);
  const x = Math.floor(a % 1000);
  return `${sign}${m}:${String(s).padStart(2, "0")}.${String(x).padStart(3, "0")}`;
}

export function fmtDelta(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  const sign = ms > 0 ? "+" : ms < 0 ? "−" : "";
  const a = Math.abs(ms);
  const s = Math.floor(a / 1000);
  const x = Math.floor(a % 1000);
  if (s >= 60) return (ms > 0 ? "+" : ms < 0 ? "−" : "") + fmtLap(a);
  return `${sign}${s}.${String(x).padStart(3, "0")}`;
}

export function fmtSec(s: number | null | undefined): string {
  if (s == null || Number.isNaN(s)) return "—";
  const sign = s > 0 ? "+" : s < 0 ? "−" : "";
  return `${sign}${Math.abs(s).toFixed(3)}`;
}

export function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

export function channelAxisLabel(
  ch?: { name?: string; unit?: string; key?: string } | null,
  fallback = ""
): string {
  const name = (ch?.name || fallback || ch?.key || "").trim();
  const unit = (ch?.unit || "").trim();
  if (!name) return unit;
  if (!unit) return name;
  const low = name.toLowerCase();
  if (low.includes(`(${unit.toLowerCase()})`) || low.endsWith(` ${unit.toLowerCase()}`)) return name;
  return `${name} (${unit})`;
}
