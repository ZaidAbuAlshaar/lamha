#!/usr/bin/env python
"""
cleanup_test_patients.py - delete the automated-flow test data from the Nazra DB.

  python cleanup_test_patients.py [--db ../../server/data/nazra.db] [--prefix "اختبار آلي"] [--dry-run]

Deletes ONLY patients whose doc.name_ar starts with the prefix, plus the check-ins and the alerts (table
`alerts`, if present) of exactly those patients. Nothing else is touched (diagnostics rows are only counted).
"""
import argparse
import json
import sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(HERE.parent.parent / "server" / "data" / "nazra.db"))
    ap.add_argument("--prefix", default="اختبار آلي")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    con = sqlite3.connect(a.db, timeout=10)
    ids = []
    for pid, doc in con.execute("SELECT id, doc FROM patients"):
        try:
            name = (json.loads(doc) or {}).get("name_ar") or ""
        except Exception:
            continue
        if name.startswith(a.prefix):
            ids.append((pid, name))
    n_ck = 0
    ck_ids = []
    for pid, _ in ids:
        rows = con.execute("SELECT id FROM checkins WHERE patient_id = ?", (pid,)).fetchall()
        ck_ids += [r[0] for r in rows]
    n_ck = len(ck_ids)
    n_diag = 0
    try:
        for cid in ck_ids:
            n_diag += con.execute("SELECT COUNT(*) FROM diagnostics WHERE checkin_id = ?", (cid,)).fetchone()[0]
    except sqlite3.Error:
        pass
    n_al = 0
    try:
        for pid, _ in ids:
            n_al += con.execute("SELECT COUNT(*) FROM alerts WHERE patient_id = ?", (pid,)).fetchone()[0]
    except sqlite3.Error:
        n_al = None
    print(json.dumps({"patients": [n for _, n in ids], "checkins": n_ck, "alerts": n_al, "linked_diagnostics_left_untouched": n_diag, "dry_run": a.dry_run}, ensure_ascii=False))
    if not a.dry_run and ids:
        with con:
            for pid, _ in ids:
                con.execute("DELETE FROM checkins WHERE patient_id = ?", (pid,))
                if n_al is not None:
                    con.execute("DELETE FROM alerts WHERE patient_id = ?", (pid,))
                con.execute("DELETE FROM patients WHERE id = ?", (pid,))
        print(f"deleted {len(ids)} patients, {n_ck} check-ins, {n_al} alerts")
    con.close()


if __name__ == "__main__":
    main()
