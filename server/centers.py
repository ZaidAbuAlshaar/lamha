"""Partner health centers (demo data, fake contacts) and offline nearest-center lookup (haversine)."""
from __future__ import annotations

import json
import math
from pathlib import Path

_PATH = Path(__file__).parent / "static_data" / "centers.json"
AMMAN = (31.9539, 35.9106)  # used when a patient has no coordinates


def all_centers() -> list[dict]:
    return json.loads(_PATH.read_text(encoding="utf-8"))["centers"]


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def by_distance(lat: float | None, lon: float | None) -> list[dict]:
    """All centers sorted nearest first, each with `distance_km` (rounded to 0.1)."""
    here = (lat, lon) if lat is not None and lon is not None else AMMAN
    out = [{**c, "distance_km": round(haversine_km(here, (c["lat"], c["lon"])), 1)} for c in all_centers()]
    return sorted(out, key=lambda c: c["distance_km"])


def nearest(lat: float | None, lon: float | None) -> dict:
    return by_distance(lat, lon)[0]
