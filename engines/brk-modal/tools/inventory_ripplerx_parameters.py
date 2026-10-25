#!/usr/bin/env python3
"""Inventory RipplerX parameter declarations against imported factory programs."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

PARAMETER_RE = re.compile(
    r'AudioParameter(?P<kind>Choice|Float|Bool|Int)>\(\s*"(?P<id>[^"]+)"\s*,\s*"(?P<label>[^"]+)"',
    re.MULTILINE,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--processor", type=Path, required=True)
    parser.add_argument("--programs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        source = args.processor.read_text(encoding="utf-8")
        declarations = []
        seen: set[str] = set()
        for match in PARAMETER_RE.finditer(source):
            key = match.group("id")
            if key in seen:
                raise ValueError(f"duplicate processor parameter {key}")
            seen.add(key)
            declarations.append({
                "id": key,
                "label": match.group("label"),
                "kind": match.group("kind").lower(),
                "declarationOrder": len(declarations),
            })
        if not declarations:
            raise ValueError("no AudioParameter declarations found")
        programs = json.loads(args.programs.read_text(encoding="utf-8"))
        usage: dict[str, list[str]] = {}
        for program in programs["programs"]:
            for key in program["parameters"]:
                usage.setdefault(key, []).append(program["name"])
        declared_ids = {item["id"] for item in declarations}
        preset_ids = set(usage)
        for item in declarations:
            names = usage.get(item["id"], [])
            item["factoryProgramCount"] = len(names)
            item["factoryPrograms"] = names
            item["compatibilityPriority"] = "factory-required" if names else "source-only"
        report = {
            "schema": "brk-modal-ripplerx-parameter-inventory-v1",
            "upstreamVersion": programs["upstream"]["version"],
            "declaredCount": len(declarations),
            "factoryStateKeyCount": len(preset_ids),
            "declaredNotInFactoryPrograms": sorted(declared_ids - preset_ids),
            "factoryProgramKeysNotDeclared": sorted(preset_ids - declared_ids),
            "parameters": declarations,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"inventory_ripplerx_parameters: {exc}", file=sys.stderr)
        return 1
    print(f"inventoried {len(declarations)} declarations and {len(preset_ids)} factory keys")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
