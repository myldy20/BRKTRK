#!/usr/bin/env python3
"""Compare BRK Modal and RipplerX matched factory benchmarks from one runner."""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import platform
from pathlib import Path
import statistics
import sys


def read_report(path: Path) -> dict[str, object]:
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("schema") != "brk-modal-p45-benchmark-v1":
        raise ValueError(f"unexpected benchmark schema in {path}")
    return report


def cpu_model() -> str:
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        for line in cpuinfo.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.lower().startswith("model name") and ":" in line:
                return line.split(":", 1)[1].strip()
    return platform.processor() or "unknown"


def geometric_mean(values: list[float]) -> float:
    positive = [value for value in values if value > 0.0]
    if not positive:
        return 0.0
    return math.exp(sum(math.log(value) for value in positive) / len(positive))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--brk", type=Path, required=True)
    parser.add_argument("--ripplerx", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    try:
        brk = read_report(args.brk)
        ripplerx = read_report(args.ripplerx)
        if brk["sampleRate"] != ripplerx["sampleRate"] or brk["blockSize"] != ripplerx["blockSize"]:
            raise ValueError("benchmark sample rate/block size mismatch")
        brk_cases = {
            item["id"]: item
            for item in brk["cases"]  # type: ignore[index]
            if item.get("lane") == "matched-factory"
        }
        upstream_cases = {item["id"]: item for item in ripplerx["cases"]}  # type: ignore[index]
        shared = sorted(set(brk_cases) & set(upstream_cases))
        if len(shared) != 15:
            raise ValueError(f"expected 15 matched benchmark cases, found {len(shared)}")

        rows: list[dict[str, object]] = []
        for case_id in shared:
            candidate = brk_cases[case_id]
            reference = upstream_cases[case_id]
            row: dict[str, object] = {
                "case_id": case_id,
                "program_index": candidate["programIndex"],
                "voices": candidate["voices"],
            }
            for percentile in ("p50Microseconds", "p95Microseconds", "p99Microseconds", "maxMicroseconds"):
                brk_value = float(candidate[percentile])
                upstream_value = float(reference[percentile])
                prefix = percentile.replace("Microseconds", "").replace("max", "maximum")
                row[f"brk_{prefix}_us"] = brk_value
                row[f"ripplerx_{prefix}_us"] = upstream_value
                row[f"brk_over_ripplerx_{prefix}_ratio"] = brk_value / upstream_value if upstream_value > 0.0 else 0.0
            row["brk_p99_deadline_fraction"] = candidate["p99DeadlineFraction"]
            row["ripplerx_p99_deadline_fraction"] = reference["p99DeadlineFraction"]
            rows.append(row)

        args.output_dir.mkdir(parents=True, exist_ok=True)
        with (args.output_dir / "benchmark-comparison.csv").open("w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)

        ratios = [float(row["brk_over_ripplerx_p99_ratio"]) for row in rows]
        stress_cases = [item for item in brk["cases"] if item.get("lane") == "brk-stress"]  # type: ignore[index]
        summary = {
            "schema": "brk-modal-p45-benchmark-comparison-v1",
            "environment": {
                "system": platform.system(),
                "release": platform.release(),
                "machine": platform.machine(),
                "cpuModel": cpu_model(),
                "logicalCpuCount": os.cpu_count(),
                "python": platform.python_version(),
                "githubRunId": os.environ.get("GITHUB_RUN_ID", ""),
                "githubRunnerName": os.environ.get("RUNNER_NAME", ""),
            },
            "sampleRate": brk["sampleRate"],
            "blockSize": brk["blockSize"],
            "mode": brk["mode"],
            "matchedCaseCount": len(rows),
            "p99RatioBrkOverRipplerX": {
                "geometricMean": geometric_mean(ratios),
                "median": statistics.median(ratios),
                "minimum": min(ratios),
                "maximum": max(ratios),
            },
            "interpretation": (
                "Ratios below 1 mean BRK Modal used less wall time in this same-runner microbenchmark. "
                "GitHub-hosted results are comparative CI evidence, not TrimUI Brick evidence."
            ),
            "brkStressCases": stress_cases,
        }
        (args.output_dir / "benchmark-comparison-summary.json").write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        print(f"matched_benchmark_case_count={len(rows)}")
        print(f"p99_ratio_geomean={geometric_mean(ratios):.6f}")
        print(f"p99_ratio_median={statistics.median(ratios):.6f}")
        return 0
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"compare_p45_benchmarks: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
