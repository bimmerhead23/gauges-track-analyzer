import { useEffect, useState } from "react";
import { api } from "../api";

type Item = { key: string; label: string; value: number; unit: string; flag: string };
type Row = { lap_id: number; number: number; items: Item[] };

export default function MechanicalStrip({ lapIds }: { lapIds: number[] }) {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!lapIds.length) {
      setRows([]);
      return;
    }
    let cancel = false;
    api.mechanical(lapIds).then((res) => {
      if (!cancel) setRows(res.laps || []);
    }).catch(() => {
      if (!cancel) setRows([]);
    });
    return () => {
      cancel = true;
    };
  }, [lapIds.join(",")]);

  const visible = rows.filter((r) => r.items.length);
  if (!visible.length) return null;
  return (
    <div className="mech-strip">
      {visible.map((r) => (
        <div key={r.lap_id} className="mech-lap">
          <span className="muted">L{r.number}</span>
          {r.items.map((item) => (
            <span key={item.key} className={`pill${item.flag ? " mech-flag" : ""}`} title={item.flag || "in range"}>
              {item.label} {item.value} {item.unit}
              {item.flag ? ` · ${item.flag}` : ""}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
