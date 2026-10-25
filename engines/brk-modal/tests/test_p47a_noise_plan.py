#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def digest_tree(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: test_p47a_noise_plan.py <generator.py>")
    generator = Path(sys.argv[1])
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        first = root / "first"
        second = root / "second"
        subprocess.run([sys.executable, str(generator), "--output-dir", str(first)], check=True)
        subprocess.run([sys.executable, str(generator), "--output-dir", str(second)], check=True)
        assert digest_tree(first) == digest_tree(second)

        plan = json.loads((first / "capture-plan.json").read_text(encoding="utf-8"))
        rows = list(csv.DictReader((first / "cases.csv").open(encoding="utf-8")))
        seeds = list(csv.DictReader((first / "seeds.csv").open(encoding="utf-8")))
        assert plan["schema"] == "brk-modal-p47a-noise-plan-v1"
        assert plan["seedPolicy"]["seedCount"] == 16
        assert len(plan["seedPolicy"]["seeds"]) == 16
        assert len(seeds) == 16
        assert len(rows) == 32
        assert {row["model"] for row in rows} == {"Ride2", "Crash"}
        assert all(int(row["program_index"]) in (22, 23) for row in rows)
        assert all(int(row["seed_decimal"]) != 0 for row in rows)
        assert all(row["upstream_filename"] != row["brk_filename"] for row in rows)
        assert plan["waveformCorrelationPassFail"] is False
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
