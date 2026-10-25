#!/usr/bin/env python3
"""Import RipplerX factory-program XML into a lossless BRK Modal JSON bundle.

Copyright (C) 2026 Myldy design / Ilya Tolstoukhov
GPL-3.0-only. Derived data remains under the RipplerX GPL-3.0 terms.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

PROGRAMS = (
    "Init", "Harpsi", "Harp", "Sankyo", "Tubes", "Stars", "DoorBell", "Bells",
    "Bells2", "KeyRing", "Sink", "Cans", "Gong", "Bong", "Marimba", "Fight",
    "Tabla", "Tabla2", "Strings", "OldClock", "Crystal", "Ride", "Ride2", "Crash",
    "Vibes", "Flute", "Fifths", "Kalimba",
)


def resolve_preset_dir(root: Path) -> Path:
    candidates = (root / "resources" / "presets", root / "presets", root)
    for candidate in candidates:
        if candidate.is_dir() and any(candidate.glob("*.xml")):
            return candidate
    raise FileNotFoundError(f"No RipplerX preset directory below {root}")


def parse_program(path: Path) -> dict[str, float | None]:
    root = ET.parse(path).getroot()
    if root.tag != "PARAMETERS":
        raise ValueError(f"{path}: expected PARAMETERS root, got {root.tag}")
    values: dict[str, float | None] = {}
    for node in root.findall("PARAM"):
        key = node.get("id")
        raw = node.get("value")
        if not key:
            raise ValueError(f"{path}: PARAM without id")
        if key in values:
            raise ValueError(f"{path}: duplicate parameter {key}")
        if raw is None:
            values[key] = None
            continue
        value = float(raw)
        if not math.isfinite(value):
            raise ValueError(f"{path}: non-finite parameter {key}")
        values[key] = value
    if not values:
        raise ValueError(f"{path}: empty preset")
    return dict(sorted(values.items()))


def build_bundle(root: Path, allow_partial: bool) -> dict[str, object]:
    preset_dir = resolve_preset_dir(root)
    programs: list[dict[str, object]] = []
    missing: list[str] = []
    for index, name in enumerate(PROGRAMS):
        path = preset_dir / f"{name}.xml"
        if not path.exists():
            missing.append(name)
            continue
        programs.append({
            "index": index,
            "name": name,
            "source": str(path.relative_to(root)) if path.is_relative_to(root) else str(path),
            "parameters": parse_program(path),
        })
    if missing and not allow_partial:
        raise FileNotFoundError("Missing factory programs: " + ", ".join(missing))
    return {
        "schema": "brk-modal-ripplerx-programs-v1",
        "schemaVersion": 1,
        "upstream": {
            "name": "RipplerX",
            "version": "1.5.18",
            "repository": "https://github.com/tiagolr/ripplerx",
            "license": "GPL-3.0-only",
        },
        "programOrder": list(PROGRAMS),
        "programs": programs,
        "missingPrograms": missing,
        "notes": [
            "Numeric values and valueless PARAM nodes are preserved from upstream XML.",
            "A JSON null means the XML PARAM had an id but no value attribute.",
            "Mapping into the BRK Modal Patch/ABI is a separate versioned migration step.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args()
    try:
        bundle = build_bundle(args.upstream_root.resolve(), args.allow_partial)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(bundle, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, ValueError, ET.ParseError) as exc:
        print(f"import_ripplerx_presets: {exc}", file=sys.stderr)
        return 1
    print(f"wrote {len(bundle['programs'])} programs to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
