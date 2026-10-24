"""Demo coordinates for the seeded patients (بيانات تجريبية) so partner-center alerts route to the nearest center.
Visitors get no coordinates -> alerts fall back to Amman."""
from __future__ import annotations

# patient id -> (lat, lon) of their town (approximate town centre, not a home address)
TOWN_COORDS = {
    "p1": (32.20, 35.62),  # Deir Alla
    "p2": (32.34, 36.21),  # Mafraq
    "p3": (32.29, 36.32),  # Zaatari
    "p4": (32.33, 35.75),  # Ajloun
    "p5": (30.84, 35.60),  # Tafileh
    "p6": (31.83, 36.81),  # Azraq
}


def seed():
    import store
    for pid, (lat, lon) in TOWN_COORDS.items():
        p = store.get_patient(pid)
        if not p:
            continue
        p["lat"], p["lon"] = lat, lon
        p.setdefault("consent", {"share_emergency": True, "notify_family": False, "receive_report": False})
        store.put_patient(p)
