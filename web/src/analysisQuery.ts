const KEY = "gauges.analysis";

/** Last Analysis selection, so Library → Analysis returns to the same laps. */
export function rememberAnalysis(sessions: number[], laps: number[]): string {
  if (!sessions.length || !laps.length) return "";
  const q = `?sessions=${sessions.join(",")}&laps=${laps.join(",")}`;
  try {
    sessionStorage.setItem(KEY, q);
  } catch {
    /* storage unavailable */
  }
  return q;
}

export function savedAnalysisSearch(): string {
  try {
    const q = sessionStorage.getItem(KEY) || "";
    return /^\?sessions=\d+(,\d+)*&laps=\d+(,\d+)*$/.test(q) ? q : "";
  } catch {
    return "";
  }
}
