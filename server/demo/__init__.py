"""Demo data (all clearly labelled «بيانات تجريبية»). Each feature adds a module here with `seed()`;
`reset_all()` wipes the demo DB state and re-seeds everything. One command: scripts/reset_demo.ps1."""
from __future__ import annotations

import importlib
import pkgutil


def reset_all() -> list[str]:
    import store
    with store._lock:
        c = store.con()
        for (name,) in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
            if not name.startswith("sqlite_"):
                c.execute(f'DELETE FROM "{name}"')
        c.commit()
    store.seed_if_empty()
    done = ["base"]
    for m in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
        mod = importlib.import_module(f"{__name__}.{m.name}")
        if hasattr(mod, "seed"):
            mod.seed()
            done.append(m.name)
    return done
