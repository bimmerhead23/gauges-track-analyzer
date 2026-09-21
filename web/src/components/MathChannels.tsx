import { useState } from "react";
import { api } from "../api";
import type { MathChannel } from "../types";

export default function MathChannels({
  math,
  onChange,
}: {
  math: MathChannel[];
  onChange: (next: MathChannel[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expression, setExpression] = useState("");
  const [unit, setUnit] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    setErr("");
    setBusy(true);
    try {
      await api.createMath({ name: name.trim(), expression: expression.trim(), unit: unit.trim() });
      onChange(await api.math());
      setName("");
      setExpression("");
      setUnit("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setErr("");
    try {
      await api.deleteMath(id);
      onChange(await api.math());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="math-box">
      <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide math channels" : "Math channels"}
      </button>
      {open && (
        <div className="math-form">
          <p className="muted">
            Expression uses channel keys (rpm, tps, brake, gps_speed_mph, wheel_speed_mph, gps_lat_g, gps_long_g). Example: rpm / gps_speed_mph
          </p>
          {math.map((m) => (
            <div key={m.id} className="math-row">
              <span>
                {m.name}
                <div className="muted">{m.expression}</div>
              </span>
              <button type="button" className="ghost" onClick={() => remove(m.id)}>
                Delete
              </button>
            </div>
          ))}
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Expression" value={expression} onChange={(e) => setExpression(e.target.value)} />
          <input placeholder="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
          <button type="button" className="primary" disabled={busy || !name.trim() || !expression.trim()} onClick={create}>
            Add
          </button>
          {err && <div className="err">{err}</div>}
        </div>
      )}
    </div>
  );
}
