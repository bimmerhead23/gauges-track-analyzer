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
  const columns: { key: string; label: string }[] = [];
  for (const row of visible) {
    for (const item of row.items) {
      if (!columns.some((c) => c.key === item.key)) columns.push({ key: item.key, label: item.label });
    }
  }
  return (
    <div className="mech-strip">
      <table className="mech-table">
        <thead>
          <tr>
            <th>Lap</th>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.lap_id}>
              <td>L{r.number}</td>
              {columns.map((c) => {
                const item = r.items.find((i) => i.key === c.key);
                if (!item) return <td key={c.key}>—</td>;
                return (
                  <td key={c.key} className={item.flag ? "mech-flag" : ""} title={item.flag || "in range"}>
                    {item.value} {item.unit}
                    {item.flag ? ` · ${item.flag}` : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
