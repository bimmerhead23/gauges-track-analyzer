import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDelta, fmtLap, fmtWhen } from "../format";
import { useTheme } from "../theme";
import type { Lap, Session } from "../types";
import { convertMaybe, useUnitPref } from "../units";

const SECTOR_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#f778ba", "#a371f7", "#ff7b72", "#56d4dd", "#79c0ff"];

type Pt = { lapNo: number; ms: number };

function flying(laps: Lap[]): Lap[] {
  return laps.filter((l) => l.kind === "valid" && l.time_ms > 0).sort((a, b) => a.number - b.number);
}

function slopeMs(pts: Pt[]): number | null {
  return fitLine(pts)?.slope ?? null;
}

function fitLine(pts: Pt[]): { slope: number; intercept: number } | null {
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.lapNo, 0) / n;
  const my = pts.reduce((a, p) => a + p.ms, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.lapNo - mx) * (p.ms - my);
    den += (p.lapNo - mx) ** 2;
  }
  if (den < 1e-6) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

function trendText(msPerLap: number | null, n: number): string {
  if (n < 2 || msPerLap == null) return "Need at least 2 flying laps for a trend";
  const s = msPerLap / 1000;
  if (n < 3) return `${s > 0 ? "+" : "−"}${Math.abs(s).toFixed(3)} s/lap between the two flying laps`;
  if (Math.abs(s) < 0.02) return "Flat — under 0.02 s per lap";
  return `${s > 0 ? "+" : "−"}${Math.abs(s).toFixed(3)} s/lap · ${s > 0 ? "slowing through the run" : "coming in"}`;
}

type Hit = { cx: number; cy: number; text: string };

type PlotTheme = { bg: string; grid: string; text: string; muted: string; line: string };

function readPlotTheme(): PlotTheme {
  const css = (name: string, fallback: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  return {
    bg: css("--plot-bg", "#121421"),
    grid: css("--plot-grid", "#3a3c4e"),
    text: css("--plot-axis", "#aeb3c9"),
    muted: css("--muted", "#8b949e"),
    line: css("--line", "#44475a"),
  };
}

function drawSeries(
  canvas: HTMLCanvasElement,
  series: { color: string; pts: Pt[]; dashed?: boolean }[],
  yTick: (ms: number) => string,
  hoverLap: number | null,
): Hit[] {
  const dpr = 2;
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 220;
  canvas.width = Math.max(2, Math.round(cssW * dpr));
  canvas.height = Math.max(2, Math.round(cssH * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const theme = readPlotTheme();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, cssW, cssH);
  const pad = { l: 72, r: 16, t: 16, b: 28 };
  const all = series.flatMap((s) => s.pts);
  if (all.length < 1) {
    ctx.fillStyle = theme.muted;
    ctx.font = "13px sans-serif";
    ctx.fillText("No flying laps in this outing.", pad.l, 40);
    return [];
  }
  const xs = all.map((p) => p.lapNo);
  const ys = all.map((p) => p.ms);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x0 === x1) {
    x0 -= 1;
    x1 += 1;
  }
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const yPad = Math.max(80, (y1 - y0) * 0.12);
  y0 -= yPad;
  y1 += yPad;
  if (y0 === y1) y1 = y0 + 1000;
  const plotW = cssW - pad.l - pad.r;
  const plotH = cssH - pad.t - pad.b;
  const X = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * plotW;
  const Y = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * plotH;

  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.font = "11px sans-serif";
  ctx.fillStyle = theme.text;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const ms = y0 + ((y1 - y0) * i) / 4;
    const y = Y(ms);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(cssW - pad.r, y);
    ctx.stroke();
    ctx.fillText(yTick(ms), pad.l - 8, y);
  }
  if (y0 < 0 && y1 > 0) {
    ctx.strokeStyle = theme.line;
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(0));
    ctx.lineTo(cssW - pad.r, Y(0));
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const lapNos = [...new Set(xs)].sort((a, b) => a - b);
  const step = Math.max(1, Math.ceil(lapNos.length / 12));
  for (let i = 0; i < lapNos.length; i += step) {
    const n = lapNos[i];
    ctx.fillText(String(n), X(n), cssH - pad.b + 8);
  }

  const hits: Hit[] = [];
  for (const s of series) {
    if (s.pts.length < 1) continue;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash(s.dashed ? [5, 4] : []);
    ctx.beginPath();
    s.pts.forEach((p, i) => {
      const x = X(p.lapNo);
      const y = Y(p.ms);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    if (s.dashed) continue;
    for (const p of s.pts) {
      const x = X(p.lapNo);
      const y = Y(p.ms);
      const hot = hoverLap === p.lapNo;
      ctx.beginPath();
      ctx.arc(x, y, hot ? 5 : 3.2, 0, Math.PI * 2);
      ctx.fill();
      hits.push({ cx: x, cy: y, text: "" });
    }
  }
  return hits;
}

function StintChart({
  series,
  yTick,
  height,
  hover,
  onHover,
}: {
  series: { color: string; pts: Pt[]; dashed?: boolean; label?: string }[];
  yTick: (ms: number) => string;
  height: number;
  hover: { lapNo: number; text: string } | null;
  onHover: (lapNo: number | null, text: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  const hits = useRef<{ lapNo: number; cx: number; cy: number; text: string }[]>([]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const labeled: { color: string; pts: Pt[]; dashed?: boolean }[] = series.map((s) => ({
      color: s.color,
      pts: s.pts,
      dashed: s.dashed,
    }));
    drawSeries(c, labeled, yTick, hover?.lapNo ?? null);
    // Pixel x of each point, matching drawSeries, so hover can find the nearest lap.
    const cssW = c.clientWidth || 640;
    const pad = { l: 72, r: 16 };
    const all = series.flatMap((s) => (s.dashed ? [] : s.pts));
    if (!all.length) {
      hits.current = [];
      return;
    }
    let x0 = Math.min(...all.map((p) => p.lapNo));
    let x1 = Math.max(...all.map((p) => p.lapNo));
    if (x0 === x1) {
      x0 -= 1;
      x1 += 1;
    }
    const plotW = cssW - pad.l - pad.r;
    const X = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * plotW;
    hits.current = [];
    for (const s of series) {
      if (s.dashed) continue;
      for (const p of s.pts) {
        hits.current.push({ lapNo: p.lapNo, cx: X(p.lapNo), cy: 0, text: `${s.label || "Lap"} L${p.lapNo} ${yTick(p.ms)}` });
      }
    }
  }, [series, yTick, hover?.lapNo, theme, height]);

  return (
    <canvas
      ref={canvas}
      className="stint-canvas"
      style={{ height }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        let best: { lapNo: number; text: string; d: number } | null = null;
        for (const h of hits.current) {
          const d = Math.abs(h.cx - x);
          if (!best || d < best.d) best = { lapNo: h.lapNo, text: h.text, d };
        }
        if (!best || best.d > 18) onHover(null, "");
        else onHover(best.lapNo, best.text);
      }}
      onMouseLeave={() => onHover(null, "")}
    />
  );
}

function Outing({ session }: { session: Session }) {
  const pref = useUnitPref();
  const laps = useMemo(
    () => [...(session.laps || [])].sort((a, b) => a.number - b.number),
    [session.laps],
  );
  const fly = flying(laps);
  const [hover, setHover] = useState<{ lapNo: number; text: string } | null>(null);

  const sectorIdx = [...new Set(fly.flatMap((l) => (l.sectors || []).map((s) => s.index)))].sort((a, b) => a - b);
  const lapPts: Pt[] = fly.map((l) => ({ lapNo: l.number, ms: l.time_ms }));
  const lapFit = fitLine(lapPts);
  const lapSlope = lapFit?.slope ?? null;
  const best = fly.length ? Math.min(...fly.map((l) => l.time_ms)) : null;
  const spread = fly.length > 1 ? Math.max(...fly.map((l) => l.time_ms)) - (best || 0) : null;

  const sectorSeries = sectorIdx.map((idx, i) => {
    const pts: Pt[] = [];
    let bestMs = Infinity;
    for (const l of fly) {
      const s = (l.sectors || []).find((x) => x.index === idx);
      if (!s || s.time_ms == null) continue;
      bestMs = Math.min(bestMs, s.time_ms);
      pts.push({ lapNo: l.number, ms: s.time_ms });
    }
    const rel = pts.map((p) => ({ lapNo: p.lapNo, ms: p.ms - (Number.isFinite(bestMs) ? bestMs : 0) }));
    return { idx, color: SECTOR_COLORS[i % SECTOR_COLORS.length], pts, rel, slope: slopeMs(rel) };
  });
  const losing = [...sectorSeries].filter((s) => s.slope != null && s.pts.length >= 3).sort((a, b) => (b.slope || 0) - (a.slope || 0))[0];

  const sheet = session.log_sheet || {};
  const tempU = pref === "metric" ? "°C" : "°F";
  const trackT = convertMaybe(sheet.track_temp_f, "°F", tempU);
  const equal = laps.some((l) => l.sectors_source === "equal");
  const when = fmtWhen(session.started_at);

  const lapTrend =
    lapFit && fly.length >= 2
      ? fly.map((l) => ({ lapNo: l.number, ms: lapFit.intercept + lapFit.slope * l.number }))
      : [];

  return (
    <section className="card stint-outing">
      <div className="stint-head">
        <b>{session.layout?.track_name || "Session"}</b>
        <span className="muted">{session.layout?.name}</span>
        <span className="muted">{when}</span>
        <span className="muted">{session.filename.replace(/\.csv$/i, "")}</span>
      </div>
      <div className="stint-stats">
        <span className="pill">{fly.length} flying</span>
        <span className="pill">Best {fmtLap(best)}</span>
        <span className="pill">Spread {spread == null ? "—" : fmtDelta(spread)}</span>
        <span className="pill">{trendText(lapSlope, fly.length)}</span>
        {losing && losing.slope != null && (
          <span className="pill">
            S{losing.idx} {losing.slope > 20 ? "giving up" : losing.slope < -20 ? "coming back" : "flat"}{" "}
            {losing.slope > 0 ? "+" : "−"}
            {Math.abs(losing.slope / 1000).toFixed(3)} s/lap
          </span>
        )}
      </div>
      <p className="muted" style={{ margin: "8px 0" }}>
        {[
          sheet.fuel ? `Fuel ${sheet.fuel}` : "",
          trackT != null ? `Track ${trackT.toFixed(0)} ${tempU}` : "",
          sheet.tyre_set ? sheet.tyre_set : "",
          sheet.tyre_health ? sheet.tyre_health : "",
        ]
          .filter(Boolean)
          .join(" · ") || "No log sheet on this outing."}{" "}
        Out, in, pit, and invalid laps stay in the table and off the chart so a slow out-lap does not flatten the slope.
      </p>
      {equal && (
        <p className="err" style={{ marginTop: 0 }}>
          Some laps fell back to equal thirds. Place sector splits before trusting which sector is giving up time.
        </p>
      )}
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        Flying lap time {hover ? `· ${hover.text}` : ""}
      </div>
      <StintChart
        height={240}
        yTick={(ms) => fmtLap(ms)}
        hover={hover}
        onHover={(lapNo, text) => setHover(lapNo == null ? null : { lapNo, text })}
        series={[
          { color: "#ff7931", pts: lapPts, label: "Lap" },
          ...(lapTrend.length ? [{ color: "#aeb3c9", pts: lapTrend, dashed: true, label: "Trend" }] : []),
        ]}
      />
      {sectorSeries.length > 0 && (
        <>
          <div className="stint-legend">
            {sectorSeries.map((s) => (
              <span key={s.idx}>
                <i style={{ background: s.color }} /> S{s.idx} vs its best
              </span>
            ))}
          </div>
          <StintChart
            height={200}
            yTick={(ms) => fmtDelta(ms)}
            hover={hover}
            onHover={(lapNo, text) => setHover(lapNo == null ? null : { lapNo, text })}
            series={sectorSeries.map((s) => ({ color: s.color, pts: s.rel, label: `S${s.idx}` }))}
          />
        </>
      )}
      <div style={{ overflowX: "auto" }}>
        <table className="stint-table">
          <thead>
            <tr>
              <th>Lap</th>
              <th>Kind</th>
              <th>Time</th>
              <th>vs best</th>
              {sectorIdx.map((i) => (
                <th key={i}>S{i}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {laps.map((l) => {
              const isFly = l.kind === "valid";
              return (
                <tr key={l.id} className={isFly ? "" : "stint-row-dim"}>
                  <td>L{l.number}</td>
                  <td>{l.kind === "valid" ? "flying" : l.kind}</td>
                  <td>{fmtLap(l.time_ms)}</td>
                  <td>{isFly && best != null ? fmtDelta(l.time_ms - best) : "—"}</td>
                  {sectorIdx.map((i) => {
                    const s = (l.sectors || []).find((x) => x.index === i);
                    return <td key={i}>{s ? fmtLap(s.time_ms) : "—"}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function StintTab({ sessions }: { sessions: Session[] }) {
  if (!sessions.length) return <div className="page muted">Open a session to see the stint.</div>;
  const ordered = [...sessions].sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
  return (
    <div className="page stint-page" data-export-root>
      <p className="muted" style={{ margin: 0 }}>
        Every lap in the outing, in the order it was driven. The line is flying laps only. A rising line is the car giving up time. The sector chart is each sector minus its own best, so the one climbing fastest is the one going away.
      </p>
      {ordered.map((s) => (
        <Outing key={s.id} session={s} />
      ))}
    </div>
  );
}
