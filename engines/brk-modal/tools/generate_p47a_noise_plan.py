#!/usr/bin/env python3
"""Generate the fixed BRK Modal P4.7A Ride2/Crash multi-seed capture plan."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

SCHEMA = "brk-modal-p47a-noise-plan-v1"
BRK_SEED_NAMESPACE = 0x5034374100000000
SEEDS = (
    0x00000001,
    0x12345678,
    0x87654321,
    0x9E3779B9,
    0x7F4A7C15,
    0xA5A5A5A5,
    0x5A5A5A5A,
    0x13579BDF,
    0x2468ACE0,
    0xDEADBEEF,
    0xCAFEBABE,
    0x0BADF00D,
    0xFEEDFACE,
    0xA1B2C3D4,
    0x55667788,
    0xF0F0F0F0,
)
TARGETS = (
    {"model": "Ride2", "programIndex": 22},
    {"model": "Crash", "programIndex": 23},
)


def build_rows() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for target in TARGETS:
        slug = str(target["model"]).lower()
        for seed_index, seed in enumerate(SEEDS):
            case_id = f"p47a_{slug}_seed_{seed_index:02d}_{seed:08x}"
            brk_seed = BRK_SEED_NAMESPACE | seed
            rows.append(
                {
                    "case_id": case_id,
                    "model": target["model"],
                    "program_index": target["programIndex"],
                    "seed_index": seed_index,
                    "seed_decimal": seed,
                    "seed_hex": f"0x{seed:08x}",
                    "brk_seed_decimal": brk_seed,
                    "brk_seed_hex": f"0x{brk_seed:016x}",
                    "key": 60,
                    "velocity": 0.75,
                    "note_on_frame": 0,
                    "note_off_frame": 38400,
                    "total_frames": 144000,
                    "sample_rate": 48000,
                    "block_size": 128,
                    "upstream_filename": f"{case_id}-upstream.wav",
                    "brk_filename": f"{case_id}-brk.wav",
                }
            )
    return rows


def write_plan(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = build_rows()
    fieldnames = list(rows[0])
    with (output_dir / "cases.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    with (output_dir / "seeds.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=("seed_index", "seed_decimal", "seed_hex", "brk_seed_decimal", "brk_seed_hex"),
            lineterminator="\n",
        )
        writer.writeheader()
        for index, seed in enumerate(SEEDS):
            brk_seed = BRK_SEED_NAMESPACE | seed
            writer.writerow(
                {
                    "seed_index": index,
                    "seed_decimal": seed,
                    "seed_hex": f"0x{seed:08x}",
                    "brk_seed_decimal": brk_seed,
                    "brk_seed_hex": f"0x{brk_seed:016x}",
                }
            )

    plan = {
        "schema": SCHEMA,
        "seedPolicy": {
            "seedCount": len(SEEDS),
            "upstream": "Call std::srand(seed_decimal) immediately before constructing each real pinned RipplerX AudioProcessor.",
            "brk": "Call Engine::prepare with brk_seed_decimal; the existing voice derivation and xorshift32 generator remain unchanged.",
            "pairing": "The same 32-bit seed label pairs captures, but std::rand and xorshift are intentionally different random sequences.",
            "brkSeedNamespaceHex": f"0x{BRK_SEED_NAMESPACE:016x}",
            "seeds": [
                {"index": index, "decimal": seed, "hex": f"0x{seed:08x}"}
                for index, seed in enumerate(SEEDS)
            ],
        },
        "capture": {
            "sampleRate": 48000,
            "blockSize": 128,
            "totalFrames": 144000,
            "noteOnFrame": 0,
            "noteOffFrame": 38400,
            "key": 60,
            "velocity": 0.75,
        },
        "targets": list(TARGETS),
        "caseCount": len(rows),
        "waveformCorrelationPassFail": False,
        "primaryEvidence": [
            "ensemble-averaged power spectrum",
            "100 ms RMS envelope",
            "release energy-decay curve",
            "tail energy",
            "peak and energy distributions",
            "within-engine RNG spread versus between-engine ensemble difference",
        ],
    }
    (output_dir / "capture-plan.json").write_text(
        json.dumps(plan, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    write_plan(args.output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
