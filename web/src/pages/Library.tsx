import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { fmtLap, fmtWhen } from "../format";
import LogSheetForm, { sheetFilled } from "../LogSheet";
import type { Session } from "../types";

type SortKey = "when" | "layout" | "file" | "laps" | "best" | "status";

function sessionSortValue(s: Session, key: SortKey): string | number | null {
  switch (key) {
    case "when":
      return s.started_at || s.created_at || null;
    case "layout":
      return (s.layout?.name || "").toLowerCase();
    case "file":
      return s.filename.toLowerCase();
    case "laps":
      return s.lap_count;
    case "best":
      return s.best_time_ms != null && s.best_time_ms > 0 ? s.best_time_ms : null;
    case "status":
      return s.status.toLowerCase();
  }
}

function previousAtTrack(all: Session[], current: Session): Session | null {
  const same = all
    .filter(
      (s) =>
        s.id !== current.id &&
        s.layout_id &&
        s.layout_id === current.layout_id &&
        (Boolean((s.vehicle || "").trim()) || sheetFilled(s.log_sheet)),
    )
    .sort((a, b) => String(b.started_at || b.created_at || "").localeCompare(String(a.started_at || a.created_at || "")));
  return same[0] || null;
}

function sortSessions(rows: Session[], key: SortKey, dir: 1 | -1): Session[] {
  return [...rows].sort((a, b) => {
    const av = sessionSortValue(a, key);
    const bv = sessionSortValue(b, key);
    if (av == null && bv == null) return a.id - b.id;
    if (av == null) return 1;
    if (bv == null) return -1;
    let cmp = 0;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
    if (!cmp) cmp = a.id - b.id;
    return cmp * dir;
  });
}

function VehicleField({
  sessionId,
  value,
  vehicles,
  onSaved,
}: {
  sessionId: number;
  value: string;
  vehicles: string[];
  onSaved: (s: Session) => void;
}) {
  const known = vehicles;
  const inList = Boolean(value && known.some((v) => v.toLowerCase() === value.toLowerCase()));
  const [adding, setAdding] = useState(Boolean(value) && !inList);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
    setAdding(Boolean(value) && !known.some((v) => v.toLowerCase() === value.toLowerCase()));
  }, [value, sessionId, known.join("|")]);

  async function save(name: string) {
    const s = await api.patchSession(sessionId, { vehicle: name.trim() });
    onSaved(s);
  }

  return (
    <div className="vehicle-field">
      <label className="muted">Vehicle</label>
      <select
        className="kind-select"
        value={inList ? value : adding ? "__new__" : ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new__") {
            setAdding(true);
            setDraft("");
            return;
          }
          setAdding(false);
          save(v);
        }}
      >
        <option value="">—</option>
        {known.map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
        <option value="__new__">New vehicle…</option>
      </select>
      {adding && (
        <input
          autoFocus
          placeholder="Name this car…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const t = draft.trim();
            if (t && t !== value) save(t);
            else if (!t) setAdding(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
        />
      )}
    </div>
  );
}

export default function Library() {
  const nav = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [details, setDetails] = useState<Session[]>([]);
  const [pickedLaps, setPickedLaps] = useState<number[]>([]);
  const [err, setErr] = useState("");
  const [warn, setWarn] = useState("");
  const [busy, setBusy] = useState(false);
  const [hot, setHot] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("when");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [vehicles, setVehicles] = useState<string[]>([]);
  const restoreRef = useRef<HTMLInputElement>(null);
  const [demo, setDemo] = useState(false);

  function clickSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === "when" || key === "laps" ? -1 : 1);
    }
  }

  async function refresh() {
    const [ss, v] = await Promise.all([api.sessions(), api.vehicles().catch(() => ({ vehicles: [] as string[] }))]);
    setSessions(ss);
    setVehicles(v.vehicles || []);
  }
  useEffect(() => {
    let cancel = false;
    api.health().then((h) => { if (!cancel) setDemo(!!h.demo); }).catch(() => {});
    (async () => {
      for (let n = 0; n < 10; n++) {
        try {
          await refresh();
          if (!cancel) setErr("");
          return;
        } catch (e: any) {
          if (n === 9) {
            if (!cancel) setErr(e.message || String(e));
            return;
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!sel.length) {
      setDetails([]);
      setPickedLaps([]);
      return;
    }
    let cancel = false;
    Promise.all(sel.map((id) => api.session(id)))
      .then((ss) => {
        if (cancel) return;
        setDetails(ss);
        setPickedLaps((prev) => {
          const allowed = new Set(ss.flatMap((s) => (s.laps || []).map((l) => l.id)));
          const kept = prev.filter((id) => allowed.has(id));
          const next = new Set(kept);
          for (const s of ss) {
            const flying = (s.laps || []).filter((l) => l.kind === "valid").map((l) => l.id);
            if (!flying.some((id) => next.has(id))) flying.forEach((id) => next.add(id));
          }
          return [...next];
        });
      })
      .catch(() => {
        if (!cancel) setDetails([]);
      });
    return () => {
      cancel = true;
    };
  }, [sel.join(",")]);

  async function onFiles(files: FileList | File[]) {
    setErr("");
    setWarn("");
    setBusy(true);
    const list = Array.from(files);
    const uploaded: Session[] = [];
    const noLaps: string[] = [];
    const failed: { name: string; reason: string }[] = [];
    try {
      for (const f of list) {
        try {
          if (f.size > 30 * 1024 * 1024) {
            failed.push({ name: f.name, reason: "larger than 30 MB" });
            continue;
          }
          if (!/\.csv$/i.test(f.name)) {
            failed.push({ name: f.name, reason: "not a .csv" });
            continue;
          }
          uploaded.push(await api.upload(f));
        } catch (e: any) {
          const reason = e.message || String(e);
          if (/no flying laps/i.test(reason) || /unknown track/i.test(reason)) noLaps.push(`${f.name} (${reason})`);
          else failed.push({ name: f.name, reason });
        }
      }
      await refresh();
      const parts: string[] = [];
      if (noLaps.length) {
        parts.push(
          noLaps.length === 1
            ? `${noLaps[0]} was not imported.`
            : `Not imported:\n${noLaps.map((n) => `• ${n}`).join("\n")}`
        );
      }
      if (failed.length) {
        parts.push(
          failed.length === 1
            ? `${failed[0].name} did not import:\n${failed[0].reason}`
            : `Failed to import:\n${failed.map((f) => `• ${f.name} — ${f.reason}`).join("\n")}`
        );
      }
      if (parts.length) window.alert(parts.join("\n\n"));
      const last = uploaded[uploaded.length - 1];
      if (last) setSel([last.id]);
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: number, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    } else {
      setSel([id]);
    }
  }

  function toggleLapPick(lapId: number) {
    setPickedLaps((p) => (p.includes(lapId) ? p.filter((x) => x !== lapId) : [...p, lapId]));
  }

  function openAnalysis() {
    const ids = sel.length ? sel : [];
    if (!ids.length) return;
    const flying = pickedLaps.length ? `&laps=${pickedLaps.join(",")}` : "";
    nav(`/analyze?sessions=${ids.join(",")}${flying}`);
  }

  const grouped = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of sessions) {
      const k = s.layout?.track_name || "Unknown track";
      m.set(k, [...(m.get(k) || []), s]);
    }
    return [...m.entries()].map(([track, rows]) => [track, sortSessions(rows, sortKey, sortDir)] as const);
  }, [sessions, sortKey, sortDir]);

  return (
    <div className="page" style={{ height: "calc(100% - 0px)" }}>
      <div className="grid-sessions">
        <div className="card" style={{ overflow: "auto" }}>
          <div className="card-head">
            <h2>Sessions</h2>
            <div className="toolbar-inline">
            <button
              disabled={busy}
              title="Download sessions, log sheets, vehicles, and track edits as a .gsbak archive"
              onClick={async () => {
                setBusy(true);
                setErr("");
                try {
                  await api.backupDownload();
                } catch (e: any) {
                  setErr(e.message || String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Backup
            </button>
            <input
              ref={restoreRef}
              type="file"
              accept=".gsbak,.zip"
              hidden
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.currentTarget.value = "";
                if (!file) return;
                if (
                  !confirm(
                    `Restore ${file.name}?\n\nThis replaces ALL sessions, log sheets, vehicles, and track edits with the archive. Demo/nightly reset uses the same path.\n\nThis cannot be undone except by restoring another backup.`
                  )
                ) {
                  return;
                }
                setBusy(true);
                setErr("");
                try {
                  await api.restoreBackup(file);
                  for (const k of ["ta-plotted", "ta-map-width", "ta-ch-scale"]) {
                    localStorage.removeItem(k);
                  }
                  setDetails([]);
                  setSel([]);
                  setPickedLaps([]);
                  await refresh();
                } catch (err: any) {
                  setErr(err.message || String(err));
                } finally {
                  setBusy(false);
                }
              }}
            />
            {!demo && (
            <button
              type="button"
              disabled={busy}
              title="Replace the library with a .gsbak backup"
              onClick={() => restoreRef.current?.click()}
            >
              Restore…
            </button>
            )}
            {!demo && (
            <button
              className="danger"
              disabled={busy}
              title="Delete all sessions and restore the track catalog"
              onClick={async () => {
                if (
                  !confirm(
                    "Reset the database?\n\nThis deletes ALL sessions, laps, and stored log files, and restores the track catalog to defaults (custom start/finish lines are lost).\n\nThis cannot be undone."
                  )
                ) {
                  return;
                }
                if (!confirm("Really reset everything? Last chance.")) return;
                setBusy(true);
                setErr("");
                try {
                  await api.resetDatabase();
                  for (const k of ["ta-plotted", "ta-map-width", "ta-ch-scale"]) {
                    localStorage.removeItem(k);
                  }
                  setDetails([]);
                  setSel([]);
                  setPickedLaps([]);
                  await refresh();
                } catch (e: any) {
                  setErr(e.message || String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Reset database
            </button>
            )}
            </div>
          </div>
          <div
            className={`drop ${hot ? "hot" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setHot(true);
            }}
            onDragLeave={() => setHot(false)}
            onDrop={(e) => {
              e.preventDefault();
              setHot(false);
              if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
            }}
          >
            Drop a Gauge.S CSV here, or{" "}
            <label style={{ cursor: "pointer", color: "var(--blue)" }}>
              browse
              <input
                type="file"
                accept=".csv"
                multiple
                hidden
                onChange={(e) => e.target.files && onFiles(e.target.files)}
              />
            </label>
            {busy && <div>Processing… files without flying laps are skipped.</div>}
          </div>
          {err && <div className="err">{err}</div>}
          {warn && <div className="notice warn">{warn}</div>}
          {grouped.map(([track, rows]) => (
            <div key={track} style={{ marginBottom: 16 }}>
              <div className="muted" style={{ margin: "8px 0 4px", fontWeight: 600 }}>
                {track}
              </div>
              <table>
                <thead>
                  <tr>
                    {([
                      ["when", "When"],
                      ["layout", "Layout"],
                      ["file", "File"],
                      ["laps", "Laps"],
                      ["best", "Best"],
                      ["status", "Status"],
                    ] as const).map(([key, label]) => (
                      <th
                        key={key}
                        className={`sort${sortKey === key ? " on" : ""}`}
                        onClick={() => clickSort(key)}
                      >
                        {label}
                        {sortKey === key && <span className="dir">{sortDir === 1 ? " ▲" : " ▼"}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr
                      key={s.id}
                      className={`clickable ${sel.includes(s.id) ? "selected" : ""}`}
                      onClick={(e) => toggle(s.id, e)}
                      onDoubleClick={() => nav(`/analyze?sessions=${s.id}`)}
                    >
                      <td>{fmtWhen(s.started_at)}</td>
                      <td>{s.layout?.name || "—"}</td>
                      <td>{s.filename}</td>
                      <td>
                        {s.lap_count}
                        {!s.lap_count && <span className="pill warn" style={{ marginLeft: 6 }}>no flying laps</span>}
                      </td>
                      <td>{fmtLap(s.best_time_ms)}</td>
                      <td>
                        <span className="pill">{s.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {!sessions.length && !busy && (
            <div className="muted">No sessions yet. Upload a Gauge.S log to get started.</div>
          )}
        </div>
        <div className="card" style={{ overflow: "auto" }}>
          <h2>Preview</h2>
          {!details.length && (
            <div className="muted">Select a session. Cmd/ctrl-click to add more sessions, then tick the laps you want to overlay.</div>
          )}
          {!!details.length && (
            <>
              <div className="toolbar-inline" style={{ marginBottom: 10 }}>
                <button className="primary" onClick={openAnalysis} disabled={!sel.length}>
                  Open analysis{pickedLaps.length ? ` (${pickedLaps.length} lap${pickedLaps.length === 1 ? "" : "s"})` : ""}
                </button>
                {details.length === 1 && (
                  <button
                    onClick={() =>
                      api.reprocess(details[0].id).then((s) => {
                        setDetails([s]);
                        refresh();
                      })
                    }
                  >
                    Reprocess
                  </button>
                )}
                {!demo && (
                <button
                  className="danger"
                  onClick={async () => {
                    const n = details.length;
                    const label =
                      n === 1
                        ? `Delete ${details[0].filename}?`
                        : `Delete ${n} sessions?\n${details.map((s) => s.filename).join("\n")}`;
                    if (!confirm(label)) return;
                    await Promise.all(details.map((s) => api.deleteSession(s.id)));
                    setDetails([]);
                    setSel([]);
                    setPickedLaps([]);
                    refresh();
                  }}
                >
                  Delete{details.length > 1 ? ` (${details.length})` : ""}
                </button>
                )}
              </div>
              {details.map((detail) => (
                <div key={detail.id} style={{ marginBottom: 16 }}>
                  <div className="notice">
                    <div>
                      <b>{detail.layout?.track_name || "Unknown"}</b> {detail.layout?.name}
                    </div>
                    <div className="muted">{detail.filename}</div>
                    <div className="muted">{fmtWhen(detail.started_at)}</div>
                    {detail.error && <div className="err">{detail.error}</div>}
                    {!detail.lap_count && (
                      <div className="err" style={{ marginTop: 6 }}>
                        No flying laps in this log. It is not included in analysis until you set S/F and reprocess.
                      </div>
                    )}
                  </div>
                  {(() => {
                    const prev = previousAtTrack(sessions, detail);
                    if (!prev) return null;
                    return (
                      <div className="toolbar-inline" style={{ marginBottom: 8 }}>
                        <button
                          type="button"
                          className="ghost"
                          onClick={async () => {
                            const s = await api.patchSession(detail.id, {
                              vehicle: prev.vehicle || "",
                              log_sheet: prev.log_sheet || {},
                            });
                            setDetails((ds) =>
                              ds.map((d) =>
                                d.id === s.id ? { ...d, vehicle: s.vehicle, log_sheet: s.log_sheet } : d,
                              ),
                            );
                            refresh();
                          }}
                        >
                          Copy last at this track
                        </button>
                        <span className="muted">
                          from {fmtWhen(prev.started_at)}
                          {prev.vehicle ? ` · ${prev.vehicle}` : ""}
                        </span>
                      </div>
                    );
                  })()}
                  <VehicleField
                    sessionId={detail.id}
                    value={detail.vehicle || ""}
                    vehicles={vehicles}
                    onSaved={(s) => {
                      setDetails((ds) => ds.map((d) => (d.id === s.id ? { ...d, vehicle: s.vehicle } : d)));
                      refresh();
                    }}
                  />
                  <LogSheetForm
                    sheet={detail.log_sheet}
                    notes={detail.notes}
                    onSaveSheet={async (log_sheet) => {
                      const s = await api.patchSession(detail.id, { log_sheet });
                      setDetails((ds) => ds.map((d) => (d.id === s.id ? { ...d, log_sheet: s.log_sheet } : d)));
                      refresh();
                    }}
                    onSaveNotes={async (notes) => {
                      const s = await api.patchSession(detail.id, { notes });
                      setDetails((ds) => ds.map((d) => (d.id === s.id ? { ...d, notes: s.notes } : d)));
                    }}
                  />
                  <table>
                    <thead>
                      <tr>
                        <th></th>
                        <th>Lap</th>
                        <th>Time</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detail.laps || []).map((l) => {
                        const on = pickedLaps.includes(l.id);
                        return (
                          <tr
                            key={l.id}
                            className="clickable"
                            onClick={() => toggleLapPick(l.id)}
                            style={{ opacity: on || l.kind === "valid" ? 1 : 0.65 }}
                          >
                            <td>
                              <input type="checkbox" checked={on} readOnly />
                            </td>
                            <td>L{l.number}</td>
                            <td>
                              {fmtLap(l.time_ms)} {l.is_best && <span className="pill best">best</span>}
                            </td>
                            <td>
                              <span className={`pill ${l.kind}`}>{l.kind}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
