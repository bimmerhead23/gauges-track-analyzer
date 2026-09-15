/** Capture the current analysis view as a PNG (plots, labels, map, scatter). */

function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function isPlotCanvas(c: HTMLCanvasElement): boolean {
  if (c.classList.contains("u-over")) return false;
  if (c.parentElement?.classList.contains("u-over")) return false;
  return c.width > 8 && c.height > 8;
}

function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
}

function plotCanvases(root: HTMLElement): HTMLCanvasElement[] {
  const wraps = [...root.querySelectorAll<HTMLElement>(".u-wrap")];
  const fromWraps = wraps
    .map((w) => [...w.querySelectorAll("canvas")].find(isPlotCanvas))
    .filter((c): c is HTMLCanvasElement => !!c);
  const extras = [...root.querySelectorAll<HTMLCanvasElement>("canvas")].filter((c) => {
    if (!isPlotCanvas(c)) return false;
    if (c.closest(".u-wrap")) return false;
    return true;
  });
  return [...fromWraps, ...extras];
}

function dprOf(canvas: HTMLCanvasElement): number {
  const cssW = canvas.getBoundingClientRect().width || canvas.width;
  return cssW > 0 ? canvas.width / cssW : 2;
}

function paintLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, halo: string, size: number) {
  ctx.font = `600 ${size}px "Segoe UI", sans-serif`;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.strokeStyle = halo;
  ctx.lineWidth = Math.max(2, size * 0.28);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function capturePlotRow(row: HTMLElement, bg: string, muted: string): HTMLCanvasElement | null {
  const plot = [...row.querySelectorAll("canvas")].find(isPlotCanvas);
  if (!plot) return null;
  const canvas = document.createElement("canvas");
  canvas.width = plot.width;
  canvas.height = plot.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(plot, 0, 0);
  const label = (row.querySelector(".ylabel")?.textContent || "").trim();
  if (label) {
    const dpr = dprOf(plot);
    paintLabel(ctx, label, 8 * dpr, 4 * dpr, muted, bg, 11 * dpr);
  }
  return canvas;
}

function captureMap(panel: HTMLElement, bg: string, muted: string): HTMLCanvasElement | null {
  const leaflet = panel.querySelector(".leaflet-container") as HTMLElement | null;
  if (!leaflet) return null;
  const rect = leaflet.getBoundingClientRect();
  const scale = 2;
  const w = Math.max(2, Math.round(rect.width * scale));
  const h = Math.max(2, Math.round(rect.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const ox = rect.left;
  const oy = rect.top;

  const tiles = [...leaflet.querySelectorAll<HTMLImageElement>(".leaflet-tile")].filter(
    (img) => img.complete && img.naturalWidth > 0
  );
  if (tiles.length) {
    const scratch = document.createElement("canvas");
    scratch.width = w;
    scratch.height = h;
    const sctx = scratch.getContext("2d");
    if (sctx) {
      let ok = true;
      for (const img of tiles) {
        const r = img.getBoundingClientRect();
        try {
          sctx.drawImage(img, (r.left - ox) * scale, (r.top - oy) * scale, r.width * scale, r.height * scale);
        } catch {
          ok = false;
          break;
        }
      }
      if (ok) {
        try {
          sctx.getImageData(0, 0, 1, 1);
          ctx.drawImage(scratch, 0, 0);
        } catch {
          /* tiles tainted — keep dark bg + GPS overlay */
        }
      }
    }
  }

  for (const c of leaflet.querySelectorAll("canvas")) {
    if (c.width < 2 || c.height < 2) continue;
    const r = c.getBoundingClientRect();
    try {
      ctx.drawImage(c, (r.left - ox) * scale, (r.top - oy) * scale, r.width * scale, r.height * scale);
    } catch {
      /* skip */
    }
  }

  paintLabel(ctx, "Track map", 10 * scale, 8 * scale, muted, bg, 11 * scale);
  const legend = panel.querySelector(".map-legend") as HTMLElement | null;
  if (legend) {
    const text = (legend.innerText || "").replace(/\s+/g, " ").trim();
    if (text) paintLabel(ctx, text.slice(0, 48), 10 * scale, h - 22 * scale, muted, bg, 10 * scale);
  }
  return canvas;
}

function captureScatter(panel: HTMLElement, muted: string, bg: string): HTMLCanvasElement | null {
  const plot = [...panel.querySelectorAll("canvas")].find(isPlotCanvas);
  if (!plot) return null;
  const canvas = document.createElement("canvas");
  canvas.width = plot.width;
  canvas.height = plot.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(plot, 0, 0);
  const dpr = dprOf(plot);
  paintLabel(ctx, "Scatter", 10 * dpr, 8 * dpr, muted, bg, 11 * dpr);
  return canvas;
}

function scaleToWidth(src: HTMLCanvasElement, width: number): HTMLCanvasElement {
  if (src.width === width) return src;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = Math.max(1, Math.round(src.height * (width / Math.max(1, src.width))));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function scaleToHeight(src: HTMLCanvasElement, height: number): HTMLCanvasElement {
  if (src.height === height) return src;
  const c = document.createElement("canvas");
  c.height = height;
  c.width = Math.max(1, Math.round(src.width * (height / Math.max(1, src.height))));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function stackVertical(parts: HTMLCanvasElement[], bg: string, width?: number): HTMLCanvasElement {
  const w = width || Math.max(...parts.map((p) => p.width), 1);
  const scaled = parts.map((p) => scaleToWidth(p, w));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = scaled.reduce((s, p) => s + p.height, 0);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  let y = 0;
  for (const p of scaled) {
    ctx.drawImage(p, 0, y);
    y += p.height;
  }
  return c;
}

function captureTables(root: HTMLElement, bg: string, fg: string, muted: string, line: string): HTMLCanvasElement | null {
  const tables = [...root.querySelectorAll("table")];
  if (!tables.length) return null;
  const scale = 2;
  const pad = 16 * scale;
  const rowH = 22 * scale;
  const blocks: { title: string; rows: string[][]; colors: string[][] }[] = [];
  for (const table of tables) {
    const heading = table.previousElementSibling?.textContent?.trim() || "";
    const rows: string[][] = [];
    const colors: string[][] = [];
    for (const tr of table.querySelectorAll("tr")) {
      const cells = [...tr.children] as HTMLElement[];
      rows.push(cells.map((td) => (td.innerText || "").replace(/\s+/g, " ").trim()));
      colors.push(cells.map((td) => getComputedStyle(td).color || fg));
    }
    if (rows.length) blocks.push({ title: heading, rows, colors });
  }
  if (!blocks.length) return null;
  const maxCols = Math.max(...blocks.flatMap((b) => b.rows.map((r) => r.length)), 1);
  const colW = Math.max(90 * scale, Math.min(160 * scale, 1100 / maxCols) * scale);
  const width = pad * 2 + colW * maxCols;
  let height = pad * 2;
  for (const b of blocks) {
    if (b.title) height += 28 * scale;
    height += b.rows.length * rowH + 18 * scale;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = pad;
  ctx.font = `${12 * scale}px "Segoe UI", sans-serif`;
  for (const b of blocks) {
    if (b.title) {
      ctx.fillStyle = muted;
      ctx.textBaseline = "top";
      ctx.fillText(b.title.slice(0, 80), pad, y);
      y += 24 * scale;
    }
    b.rows.forEach((row, ri) => {
      row.forEach((cell, ci) => {
        ctx.fillStyle = b.colors[ri]?.[ci] || (ri === 0 ? muted : fg);
        ctx.textBaseline = "middle";
        const x = pad + ci * colW;
        const t = cell.length > 28 ? cell.slice(0, 27) + "…" : cell;
        ctx.fillText(t, x, y + rowH / 2);
      });
      ctx.strokeStyle = line;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(pad, y + rowH);
      ctx.lineTo(canvas.width - pad, y + rowH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      y += rowH;
    });
    y += 16 * scale;
  }
  return canvas;
}

function stitch(parts: HTMLCanvasElement[], bg: string, title: string, fg: string, muted: string): HTMLCanvasElement {
  const scale = 2;
  const header = 36 * scale;
  const gap = 8 * scale;
  const width = Math.max(...parts.map((p) => p.width), 640);
  const height = header + parts.reduce((s, p) => s + p.height, 0) + gap * Math.max(0, parts.length - 1) + 12 * scale;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = fg;
  ctx.font = `600 ${14 * scale}px "Segoe UI", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(title, 16 * scale, header / 2);
  ctx.fillStyle = muted;
  ctx.font = `${11 * scale}px "Segoe UI", sans-serif`;
  ctx.fillText("Gauge.S Track Analyzer", width - 16 * scale - ctx.measureText("Gauge.S Track Analyzer").width, header / 2);
  let y = header;
  for (const p of parts) {
    ctx.drawImage(p, 0, y);
    y += p.height + gap;
  }
  return canvas;
}

function exportOverlay(workspace: HTMLElement, filename: string, title: string, bg: string, fg: string, muted: string): boolean {
  const plotRows = [...workspace.querySelectorAll<HTMLElement>(".plot-row")]
    .map((row) => capturePlotRow(row, bg, muted))
    .filter((c): c is HTMLCanvasElement => !!c);
  const story = workspace.querySelector<HTMLElement>(".panel.story");
  const deltaPlot = story ? plotCanvases(story)[0] : null;
  let delta: HTMLCanvasElement | null = null;
  if (deltaPlot) {
    delta = document.createElement("canvas");
    delta.width = deltaPlot.width;
    delta.height = deltaPlot.height;
    const dctx = delta.getContext("2d");
    if (dctx) {
      dctx.drawImage(deltaPlot, 0, 0);
      const dpr = dprOf(deltaPlot);
      paintLabel(dctx, "Time gained / lost (s)", 8 * dpr, 4 * dpr, muted, bg, 11 * dpr);
    }
  }
  const mapPanel = workspace.querySelector<HTMLElement>(".panel.map");
  const scatterPanel = workspace.querySelector<HTMLElement>(".panel.scatter");
  const map = mapPanel ? captureMap(mapPanel, bg, muted) : null;
  const scatter = scatterPanel ? captureScatter(scatterPanel, muted, bg) : null;

  if (!plotRows.length && !delta && !map && !scatter) return false;

  const gap = 8;
  const traces = plotRows.length ? stackVertical(plotRows, bg) : null;
  const sideParts = [map, scatter].filter((c): c is HTMLCanvasElement => !!c);
  const side = sideParts.length ? stackVertical(sideParts, bg) : null;

  const bodyParts: HTMLCanvasElement[] = [];
  if (traces && side) {
    const right = scaleToHeight(side, traces.height);
    const row = document.createElement("canvas");
    row.width = traces.width + gap + right.width;
    row.height = traces.height;
    const rctx = row.getContext("2d")!;
    rctx.fillStyle = bg;
    rctx.fillRect(0, 0, row.width, row.height);
    rctx.drawImage(traces, 0, 0);
    rctx.drawImage(right, traces.width + gap, 0);
    bodyParts.push(row);
  } else if (traces) {
    bodyParts.push(traces);
  } else if (side) {
    bodyParts.push(side);
  }
  if (delta) {
    const w = bodyParts[0]?.width || delta.width;
    bodyParts.push(scaleToWidth(delta, w));
  }
  if (!bodyParts.length) return false;
  downloadCanvas(stitch(bodyParts, bg, title, fg, muted), filename);
  return true;
}

export function exportViewPng(filename: string, title: string): boolean {
  const bg = css("--plot-bg", "#161b22");
  const fg = css("--text", "#e6edf3");
  const muted = css("--muted", "#8b949e");
  const line = css("--line", "#30363d");
  const workspace = document.querySelector<HTMLElement>(".workspace");
  if (workspace && workspace.querySelector(".plot-stack")) {
    return exportOverlay(workspace, filename, title, bg, fg, muted);
  }
  const roots = [...document.querySelectorAll<HTMLElement>("[data-export-root]")];
  if (!roots.length) return false;
  const parts: HTMLCanvasElement[] = [];
  for (const root of roots) {
    const rows = [...root.querySelectorAll<HTMLElement>(".plot-row")];
    if (rows.length) {
      for (const row of rows) {
        const cap = capturePlotRow(row, bg, muted);
        if (cap) parts.push(cap);
      }
    } else {
      const plots = plotCanvases(root);
      if (plots.length) parts.push(...plots);
    }
    const table = captureTables(root, bg, fg, muted, line);
    if (table) parts.push(table);
  }
  if (!parts.length) return false;
  downloadCanvas(stitch(parts, bg, title, fg, muted), filename);
  return true;
}
