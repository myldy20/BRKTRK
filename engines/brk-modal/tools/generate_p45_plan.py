#!/usr/bin/env python3
"""Generate the BRK Modal P4.5 matched-capture plan and parameter crosswalk."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
import re
import sys

IDENTITY_RE = re.compile(r'X\([^,]+,\s*(0x[0-9a-fA-F]+)u,\s*"([^"]+)"\)')


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def parse_brk_identities(path: Path) -> dict[str, int]:
    source = path.read_text(encoding="utf-8")
    result: dict[str, int] = {}
    for numeric, key in IDENTITY_RE.findall(source):
        if key in result:
            raise ValueError(f"duplicate BRK parameter key: {key}")
        result[key] = int(numeric, 16)
    if len(result) != 89:
        raise ValueError(f"expected 89 BRK identities, found {len(result)}")
    return result


def build_cases(programs: list[dict[str, object]]) -> list[dict[str, object]]:
    sample_rate = 48_000
    block_size = 128
    note_off_frame = int(0.8 * sample_rate)
    total_frames = 3 * sample_rate
    cases: list[dict[str, object]] = []

    def add_case(index: int, key: int, velocity: float, variant: str) -> None:
        name = str(programs[index]["name"])
        case_id = f"factory_{index:02d}_{slug(name)}_{variant}"
        filename = f"{case_id}.wav"
        cases.append({
            "case_id": case_id,
            "lane": "upstream-parity",
            "program_index": index,
            "program_name": name,
            "key": key,
            "velocity": velocity,
            "note_on_frame": 0,
            "note_off_frame": note_off_frame,
            "total_frames": total_frames,
            "sample_rate": sample_rate,
            "block_size": block_size,
            "reference_filename": filename,
            "candidate_filename": filename,
        })

    for index in range(len(programs)):
        add_case(index, 60, 0.75, "mid_v075")

    diagnostic_programs = (1, 12, 14, 16, 22, 25, 27)
    for index in diagnostic_programs:
        add_case(index, 36, 0.75, "low_v075")
        add_case(index, 84, 0.75, "high_v075")
        add_case(index, 60, 0.25, "mid_v025")
        add_case(index, 60, 1.00, "mid_v100")

    return cases


def build_crosswalk(
    inventory: dict[str, object], brk_identities: dict[str, int]
) -> list[dict[str, object]]:
    manual_adapted = {
        "stereoizer": "brk.stereo_mode",
    }
    migration_keys = {"a_cut", "b_cut"}
    upstream_keys: set[str] = set()
    rows: list[dict[str, object]] = []

    for item in inventory["parameters"]:  # type: ignore[index]
        upstream_key = str(item["id"])
        upstream_keys.add(upstream_key)
        factory_count = int(item["factoryProgramCount"])
        if upstream_key in brk_identities:
            status = "exact-with-state-migration" if upstream_key in migration_keys else "exact"
            brk_key = upstream_key
            notes = (
                "Legacy XML frequency is converted through the inverse signed low-cut mapping."
                if upstream_key in migration_keys
                else "Same public key and factory-facing parameter semantics."
            )
        elif upstream_key in manual_adapted:
            status = "adapted"
            brk_key = manual_adapted[upstream_key]
            notes = "Mapped to a richer BRK enum; parity capture selects the upstream-equivalent mode."
        else:
            status = "deferred"
            brk_key = ""
            notes = "Not required by the imported factory bank or not implemented in ABI v1."
        rows.append({
            "direction": "upstream-to-brk",
            "upstream_key": upstream_key,
            "upstream_kind": item["kind"],
            "upstream_label": item["label"],
            "factory_program_count": factory_count,
            "factory_required": factory_count > 0,
            "status": status,
            "brk_key": brk_key,
            "brk_numeric_id": f"0x{brk_identities[brk_key]:04x}" if brk_key else "",
            "notes": notes,
        })

    for brk_key, numeric_id in sorted(brk_identities.items(), key=lambda pair: pair[1]):
        if brk_key in upstream_keys or brk_key in manual_adapted.values():
            continue
        rows.append({
            "direction": "brk-only",
            "upstream_key": "",
            "upstream_kind": "",
            "upstream_label": "",
            "factory_program_count": 0,
            "factory_required": False,
            "status": "downstream-only",
            "brk_key": brk_key,
            "brk_numeric_id": f"0x{numeric_id:04x}",
            "notes": "BRK lifecycle, stability, presentation or deterministic-runtime extension.",
        })
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--programs", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--parameter-ids", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    try:
        programs_doc = json.loads(args.programs.read_text(encoding="utf-8"))
        inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
        programs = programs_doc["programs"]
        if len(programs) != 28:
            raise ValueError(f"expected 28 programs, found {len(programs)}")
        if inventory["declaredCount"] != 77:
            raise ValueError("unexpected upstream declaration count")
        brk_identities = parse_brk_identities(args.parameter_ids)
        cases = build_cases(programs)
        crosswalk = build_crosswalk(inventory, brk_identities)

        args.output_dir.mkdir(parents=True, exist_ok=True)
        case_fields = list(cases[0].keys())
        with (args.output_dir / "cases.csv").open("w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=case_fields, lineterminator="\n")
            writer.writeheader()
            writer.writerows(cases)

        capture_doc = {
            "schema": "brk-modal-p45-capture-plan-v1",
            "upstream": programs_doc["upstream"],
            "caseCount": len(cases),
            "commonSubsetRules": {
                "audioInput": False,
                "mtsEsp": False,
                "sampleMallet": False,
                "pitchWheel": False,
                "brkVelocityMacrosNeutral": True,
                "brkSpectralFocusNeutral": True,
                "rawOutputNoNormalization": True,
            },
            "cases": cases,
        }
        (args.output_dir / "capture-plan.json").write_text(
            json.dumps(capture_doc, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

        crosswalk_fields = list(crosswalk[0].keys())
        with (args.output_dir / "parameter-crosswalk.csv").open("w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=crosswalk_fields, lineterminator="\n")
            writer.writeheader()
            writer.writerows(crosswalk)

        counts: dict[str, int] = {}
        for row in crosswalk:
            counts[str(row["status"])] = counts.get(str(row["status"]), 0) + 1
        summary = {
            "schema": "brk-modal-p45-crosswalk-summary-v1",
            "upstreamDeclarationCount": inventory["declaredCount"],
            "upstreamFactoryRequiredCount": inventory["factoryStateKeyCount"],
            "brkParameterCount": len(brk_identities),
            "captureCaseCount": len(cases),
            "statusCounts": counts,
        }
        (args.output_dir / "crosswalk-summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"generate_p45_plan: {exc}", file=sys.stderr)
        return 1

    print(f"generated {len(cases)} capture cases and {len(crosswalk)} crosswalk rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
