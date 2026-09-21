type Turn = { n: number; apex_m: number; d0_m: number; d1_m: number; name?: string | null };

export default function TurnRail({
  turns,
  onZoom,
}: {
  turns: Turn[];
  onZoom: (range: [number, number]) => void;
}) {
  if (!turns.length) return null;
  return (
    <div className="turn-rail">
      {turns.map((t) => (
        <button key={t.n} type="button" className="ghost" title={t.name || `Turn ${t.n}`} onClick={() => onZoom([t.d0_m, t.d1_m])}>
          T{t.n}
          {t.name ? ` ${t.name}` : ""}
        </button>
      ))}
    </div>
  );
}
