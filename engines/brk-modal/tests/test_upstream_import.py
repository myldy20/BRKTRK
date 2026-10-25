#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: test_upstream_import.py IMPORTER FIXTURE_ROOT", file=sys.stderr)
        return 2
    importer = Path(sys.argv[1])
    fixture = Path(sys.argv[2])
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / "programs.json"
        subprocess.run([
            sys.executable,
            str(importer),
            "--upstream-root", str(fixture),
            "--output", str(output),
            "--allow-partial",
        ], check=True)
        bundle = json.loads(output.read_text(encoding="utf-8"))
    assert bundle["schema"] == "brk-modal-ripplerx-programs-v1"
    assert bundle["upstream"]["version"] == "1.5.18"
    assert len(bundle["programOrder"]) == 28
    assert [item["name"] for item in bundle["programs"]] == ["Init", "Harpsi"]
    assert bundle["programs"][1]["parameters"]["a_decay"] == 4.920000076293945
    assert len(bundle["missingPrograms"]) == 26
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
