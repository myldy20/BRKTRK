#!/usr/bin/env python3
"""Aggregate repeated P4.7B scalar/vector benchmark runs."""

from __future__ import annotations

import argparse
import csv
import json
import math
import platform
import statistics
from pathlib import Path
from typing import Any

SCHEMA = "brk-modal-p47b-kernel-summary-v1"
PHASES = ("controlEvent", "attackBlock", "steadyState")
PERCENTILES = ("p50Microseconds", "p95Microseconds", "p99Microseconds", "maxMicroseconds")


def geometric_mean(values: list[float]) -> float:
    positive = [value for value in values if value > 0.0 and math.isfinite(value)]
    if not positive:
        return 0.0
    return math.exp(sum(math.log(value) for value in positive) / len(positive))


def load_runs(paths: list[Path]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for path in paths:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("schema") != "brk-modal-p47b-kernel-benchmark-v1":
            raise ValueError(f"unexpected schema in {path}")
        runs.append(data)
    return runs


def index_results(run: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {(item["id"], item["requestedKernel"]): item for item in run["results"]}


def aggregate(runs: list[dict[str, Any]]) -> dict[str, Any]:
    if not runs:
        raise ValueError("no benchmark runs")
    if not all(run.get("vectorKernelAvailable") for run in runs):
        raise ValueError("vector kernel unavailable in one or more runs")

    indexed = [index_results(run) for run in runs]
    keys = sorted(indexed[0])
    if any(sorted(current) != keys for current in indexed[1:]):
        raise ValueError("benchmark case mismatch between runs")

    cases: list[dict[str, Any]] = []
    phase_ratios: dict[str, dict[str, list[float]]] = {
        phase: {percentile: [] for percentile in PERCENTILES} for phase in PHASES
    }
    faster_counts: dict[str, dict[str, int]] = {
        phase: {percentile: 0 for percentile in PERCENTILES} for phase in PHASES
    }

    case_ids = sorted({case_id for case_id, _ in keys})
    for case_id in case_ids:
        scalar_runs = [current[(case_id, "scalar")] for current in indexed]
        vector_runs = [current[(case_id, "vector4")] for current in indexed]
        if any(item["activeKernel"] != "scalar" for item in scalar_runs):
            raise ValueError(f"scalar resolution failed for {case_id}")
        if any(item["activeKernel"] != "vector4" for item in vector_runs):
            raise ValueError(f"vector resolution failed for {case_id}")

        case: dict[str, Any] = {
            "id": case_id,
            "voices": scalar_runs[0]["voices"],
            "estimatedModalWorkUnits": scalar_runs[0]["estimatedModalWorkUnits"],
            "phases": {},
        }
        for phase in PHASES:
            phase_result: dict[str, Any] = {}
            for percentile in PERCENTILES:
                scalar_value = statistics.median(float(item[phase][percentile]) for item in scalar_runs)
                vector_value = statistics.median(float(item[phase][percentile]) for item in vector_runs)
                ratio = vector_value / scalar_value if scalar_value > 0.0 else 0.0
                phase_result[percentile] = {
                    "scalarMedian": scalar_value,
                    "vectorMedian": vector_value,
                    "vectorOverScalar": ratio,
                }
                phase_ratios[phase][percentile].append(ratio)
                if 0.0 < ratio < 1.0:
                    faster_counts[phase][percentile] += 1
            case["phases"][phase] = phase_result
        cases.append(case)

    aggregate_ratios: dict[str, Any] = {}
    for phase in PHASES:
        aggregate_ratios[phase] = {}
        for percentile in PERCENTILES:
            ratios = phase_ratios[phase][percentile]
            aggregate_ratios[phase][percentile] = {
                "geometricMeanVectorOverScalar": geometric_mean(ratios),
                "medianVectorOverScalar": statistics.median(ratios),
                "minimumVectorOverScalar": min(ratios),
                "maximumVectorOverScalar": max(ratios),
                "vectorFasterCases": faster_counts[phase][percentile],
                "caseCount": len(ratios),
            }

    return {
        "schema": SCHEMA,
        "runCount": len(runs),
        "sampleRate": runs[0]["sampleRate"],
        "blockSize": runs[0]["blockSize"],
        "vectorKernelAvailable": True,
        "environment": {
            "system": platform.system(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "aggregateRatios": aggregate_ratios,
        "cases": cases,
    }


def write_csv(path: Path, summary: dict[str, Any]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "case_id",
                "voices",
                "estimated_modal_work_units",
                "phase",
                "percentile",
                "scalar_median_us",
                "vector_median_us",
                "vector_over_scalar",
            ]
        )
        for case in summary["cases"]:
            for phase in PHASES:
                for percentile in PERCENTILES:
                    item = case["phases"][phase][percentile]
                    writer.writerow(
                        [
                            case["id"],
                            case["voices"],
                            case["estimatedModalWorkUnits"],
                            phase,
                            percentile,
                            item["scalarMedian"],
                            item["vectorMedian"],
                            item["vectorOverScalar"],
                        ]
                    )


def write_report(path: Path, summary: dict[str, Any]) -> None:
    lines = [
        "# BRK Modal P4.7B kernel benchmark",
        "",
        f"Repeated runs: `{summary['runCount']}`  ",
        f"Audio geometry: `{summary['sampleRate']} Hz / {summary['blockSize']} frames`  ",
        "",
        "The benchmark separates control-event configuration, the first attack block and steady-state modal processing.",
        "Ratios below 1.0 favor Vector4. Modal count and sound state are unchanged.",
        "",
        "| Phase | Statistic | Geomean Vector/Scalar | Median | Faster cases |",
        "| --- | --- | ---: | ---: | ---: |",
    ]
    for phase in PHASES:
        for percentile in ("p50Microseconds", "p95Microseconds", "p99Microseconds"):
            item = summary["aggregateRatios"][phase][percentile]
            lines.append(
                f"| {phase} | {percentile} | {item['geometricMeanVectorOverScalar']:.4f} | "
                f"{item['medianVectorOverScalar']:.4f} | {item['vectorFasterCases']}/{item['caseCount']} |"
            )
    lines.extend(
        [
            "",
            "Control-event timing is expected to move little because modal coefficient generation remains scalar.",
            "The quality-neutral optimization target is attack and steady-state modal recurrence work.",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary = aggregate(load_runs(args.inputs))
    (args.output_dir / "p47b-kernel-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    write_csv(args.output_dir / "p47b-kernel-cases.csv", summary)
    write_report(args.output_dir / "REPORT.md", summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
