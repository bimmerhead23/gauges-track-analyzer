import type { Lap, Session } from "../types";
import { convertMaybe, preferredUnit, useUnitPref } from "../units";
import { fmtLap } from "../format";

function bestOf(laps: Lap[] | undefined): Lap | null {
  const flying = (laps || []).filter((l) => l.kind === "valid");
  if (!flying.length) return null;
  return [...flying].sort((a, b) => a.time_ms - b.time_ms)[0];
}

export default function SetupCompare({ sessions }: { sessions: Session[] }) {
  const pref = useUnitPref();
  if (sessions.length < 2) return null;
  const tempU = pref === "metric" ? "°C" : "°F";
  const pressU = preferredUnit("psi", pref);
  const showTemp = (v: number | null | undefined) => {
    const n = convertMaybe(v, "°F", tempU);
    return n == null ? "—" : n.toFixed(1);
  };
  const showP = (v: number | null | undefined) => {
    const n = convertMaybe(v, "psi", pressU);
    return n == null ? "—" : n.toFixed(1);
  };
  return (
    <div className="setup-compare">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Best</th>
            <th>Ambient {tempU}</th>
            <th>Track {tempU}</th>
            <th>Tyres</th>
            <th>Hot {pressU}</th>
            <th>Wing</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const best = bestOf(s.laps);
            const sheet = s.log_sheet || {};
            const pressures = [sheet.pressure_fl, sheet.pressure_fr, sheet.pressure_rl, sheet.pressure_rr]
              .map(showP)
              .join(" / ");
            const when = s.started_at ? new Date(s.started_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : s.filename;
            return (
              <tr key={s.id}>
                <td>{when}</td>
                <td>{best ? fmtLap(best.time_ms) : "—"}</td>
                <td>{showTemp(sheet.ambient_f)}</td>
                <td>{showTemp(sheet.track_temp_f)}</td>
                <td>{sheet.tyre_set || "—"}</td>
                <td>{pressures}</td>
                <td>{sheet.wing || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
