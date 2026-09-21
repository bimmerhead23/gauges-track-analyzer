export type Channel = { key: string; name: string; unit: string; source?: string };

export type Gate = {
  a: { lat: number; lon: number };
  b: { lat: number; lon: number };
  heading?: number;
  lat?: number;
  lon?: number;
  source?: string;
};

export type Layout = {
  id: number;
  track_id: number;
  name: string;
  direction: string;
  length_m: number;
  centroid_lat: number;
  centroid_lon: number;
  sf_gate: Gate | null;
  finish_gate: Gate | null;
  timing_mode: "loop" | "stage";
  sectors: Gate[];
  pit_polygon: { lat: number; lon: number }[] | null;
  turns?: { count?: number; source?: string; names?: Record<string, string>; complexes?: { turns: number[]; name: string }[] };
  track_name: string | null;
  venue: string | null;
};

export type Sector = { id: number; index: number; time_ms: number; distance_m: number };

export type Lap = {
  id: number;
  session_id: number;
  number: number;
  t_start_ms: number;
  t_end_ms: number;
  time_ms: number;
  distance_m: number;
  kind: string;
  sectors_source?: string;
  is_best: boolean;
  sectors?: Sector[];
};

export type LogSheet = {
  weather?: string;
  ambient_f?: number | null;
  track_temp_f?: number | null;
  wind?: string;
  tyre_set?: string;
  tyre_health?: string;
  pressure_fl?: number | null;
  pressure_fr?: number | null;
  pressure_rl?: number | null;
  pressure_rr?: number | null;
  fuel?: string;
  wing?: string;
  setup?: string;
};

export type Session = {
  id: number;
  filename: string;
  started_at: string | null;
  duration_ms: number;
  vehicle: string;
  layout_id: number | null;
  layout: Layout | null;
  sample_count: number;
  status: string;
  error: string;
  notes: string;
  log_sheet?: LogSheet;
  analysis_settings?: {
    plotted?: string[];
    chScale?: Record<string, { min: number | null; max: number | null }>;
    mapWidth?: number;
    mapColor?: string;
    gatePreset?: string;
    gates?: { channel: string; op: string; value: number }[];
    units?: "metric" | "imperial";
  };
  has_original?: boolean;
  channels: Channel[];
  bbox: { min_lat: number; max_lat: number; min_lon: number; max_lon: number; centroid_lat: number; centroid_lon: number } | null;
  created_at: string | null;
  lap_count: number;
  best_time_ms: number | null;
  laps?: Lap[];
};

export type Track = {
  id: number;
  name: string;
  venue: string;
  notes: string;
  layouts: Layout[];
};

export type MathChannel = {
  id: number;
  name: string;
  key: string;
  expression: string;
  unit: string;
  color: string;
  enabled: boolean;
};

export type XY = { x: number[]; y: (number | null)[] };

export const LAP_COLORS = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#f778ba",
  "#a371f7",
  "#79c0ff",
  "#ff7b72",
  "#56d4dd",
];
