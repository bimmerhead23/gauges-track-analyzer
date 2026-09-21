"""Numeric checks for lap distance, sectors, alignment, and cursor interpolation."""

import unittest

import numpy as np
import pandas as pd

from app.geo import accept_gps, cumulative_distance
from app.ingest import repair_stored_g
from app.laps import sector_times
from app.traces import _interp_finite, align_lap_distance


class _Lap:
    def __init__(self, lap_id, distance_m, time_ms, sectors):
        self.id = lap_id
        self.distance_m = distance_m
        self.time_ms = time_ms
        self.sectors = sectors


class _Sector:
    def __init__(self, index, time_ms, distance_m):
        self.index = index
        self.time_ms = time_ms
        self.distance_m = distance_m


class GpsTests(unittest.TestCase):
    def test_spike_is_dropped_and_distance_does_not_jump(self):
        # 10 Hz, ~20 m/s, one sample teleports ~1 km north.
        n = 20
        t = np.arange(n) * 100.0
        lat = np.full(n, 30.0)
        lon =  -97.0 + np.arange(n) * 0.00002
        lat[8] = 30.01
        valid = np.ones(n, dtype=bool)
        keep = accept_gps(lat, lon, valid, t)
        self.assertFalse(keep[8])
        self.assertTrue(keep[7] and keep[9])
        lat2 = np.where(keep, lat, np.nan)
        lon2 = np.where(keep, lon, np.nan)
        dist = cumulative_distance(lat2, lon2, keep)
        step = np.diff(dist)
        self.assertLess(float(step.max()), 30.0)

    def test_real_gap_is_kept(self):
        t = np.array([0.0, 100.0, 5000.0])
        lat = np.array([30.0, 30.0001, 30.001])
        lon = np.array([-97.0, -97.0, -97.0])
        valid = np.ones(3, dtype=bool)
        keep = accept_gps(lat, lon, valid, t)
        self.assertTrue(keep.all())


class SectorTests(unittest.TestCase):
    def test_missed_beacon_falls_back_to_equal_thirds(self):
        n = 50
        df = pd.DataFrame({
            "lat": np.full(n, 30.0),
            "lon": -97.0 + np.linspace(0, 0.01, n),
            "t_ms": np.arange(n) * 100.0,
            "dist_m": np.linspace(0, 1500, n),
            "heading_deg": np.full(n, 90.0),
            "gps_speed": np.full(n, 100.0),
        })
        lap = {"i0": 0, "i1": n - 1}
        far = {"a": {"lat": 0.0, "lon": 0.0}, "b": {"lat": 0.0, "lon": 0.01}, "heading": 0}
        layout = type("L", (), {"sectors": [far]})()
        secs, source = sector_times(df, lap, layout)
        self.assertEqual(source, "equal")
        self.assertEqual(len(secs), 3)
        self.assertAlmostEqual(sum(s["time_ms"] for s in secs), float(df["t_ms"].iloc[-1]), delta=2)


class EcuGTests(unittest.TestCase):
    def test_swapped_axes_are_put_back(self):
        n = 200
        gps_lat = np.linspace(-1, 1, n)
        gps_long = np.concatenate([np.linspace(0, 1, n // 2), np.linspace(1, -0.5, n // 2)])
        # Stored backwards: long_g holds lateral, lat_g holds longitudinal.
        sl = pd.DataFrame({
            "gps_lat_g": gps_lat,
            "gps_long_g": gps_long,
            "long_g": gps_lat,
            "lat_g": -gps_long,
        })
        fixed = repair_stored_g(sl)
        self.assertGreater(np.corrcoef(fixed["lat_g"], gps_lat)[0, 1], 0.9)
        self.assertGreater(np.corrcoef(fixed["long_g"], gps_long)[0, 1], 0.9)


class AlignTests(unittest.TestCase):
    def test_shorter_lap_sector_end_lands_on_reference(self):
        ref_sl = pd.DataFrame({"lap_dist_m": [0.0, 500.0, 1000.0], "lap_t_ms": [0.0, 10000.0, 20000.0]})
        other = pd.DataFrame({"lap_dist_m": [0.0, 400.0, 800.0], "lap_t_ms": [0.0, 11000.0, 22000.0]})
        ref = _Lap(1, 1000, 20000, [_Sector(1, 10000, 500), _Sector(2, 10000, 500)])
        lap = _Lap(2, 800, 22000, [_Sector(1, 11000, 400), _Sector(2, 11000, 400)])
        aligned = align_lap_distance(other, lap, ref_sl, ref)
        self.assertAlmostEqual(float(aligned["lap_dist_m"].iloc[-1]), 1000.0, delta=1.0)

    def test_interp_skips_nan_instead_of_zero(self):
        x = np.array([0.0, 10.0, 20.0])
        y = np.array([0.0, np.nan, 20.0])
        self.assertAlmostEqual(_interp_finite(x, y, 10.0), 10.0, places=3)


if __name__ == "__main__":
    unittest.main()
