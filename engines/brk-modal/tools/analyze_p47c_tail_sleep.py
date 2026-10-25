#!/usr/bin/env python3
"""Aggregate repeated P4.7C no-sleep/conservative-tail benchmark runs."""

from __future__ import annotations

import argparse
import csv
import json
import math
import platform
import statistics
from pathlib import Path
from typing import Any

SCHEMA = "brk-modal-p47c-tail-summary-v1"
PHASES = ("active", "decaying", "mostlySilent")
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
        if data.get("schema") != "brk-modal-p47c-tail-benchmark-v1":
            raise ValueError(f"unexpected schema in {path}")
        runs.append(data)
    return runs


def index_results(run: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["id"]: item for item in run["results"]}


def aggregate(runs: list[dict[str, Any]]) -> dict[str, Any]:
    if not runs:
        raise ValueError("no benchmark runs")
    indexed = [index_results(run) for run in runs]
    case_ids = sorted(indexed[0])
    if any(sorted(current) != case_ids for current in indexed[1:]):
        raise ValueError("benchmark case mismatch between runs")

    phase_ratios: dict[str, dict[str, list[float]]] = {
        phase: {percentile: [] for percentile in PERCENTILES} for phase in PHASES
    }
    faster_counts: dict[str, dict[str, int]] = {
        phase: {percentile: 0 for percentile in PERCENTILES} for phase in PHASES
    }
    cases: list[dict[str, Any]] = []

    for case_id in case_ids:
        items = [current[case_id] for current in indexed]
        case: dict[str, Any] = {
            "id": case_id,
            "voices": items[0]["voices"],
            "estimatedModalWorkUnits": items[0]["estimatedModalWorkUnits"],
            "firstSleepBlockMedian": statistics.median(float(item["firstSleepBlock"]) for item in items),
            "sleepEntriesMinimum": min(int(item["sleepEntries"]) for item in items),
            "skippedVoiceFramesMedian": statistics.median(float(item["skippedVoiceFrames"]) for item in items),
            "candidateSkippedFractionMedian": statistics.median(
                float(item["candidateSkippedFraction"]) for item in items
            ),
            "audioError": {
                "maximumMaxAbs": max(float(item["audioError"]["maxAbs"]) for item in items),
                "medianRms": statistics.median(float(item["audioError"]["rms"]) for item in items),
                "minimumSnrDb": min(float(item["audioError"]["snrDb"]) for item in items),
            },
            "phases": {},
        }
        for phase in PHASES:
            phase_result: dict[str, Any] = {}
            for percentile in PERCENTILES:
                oracle = statistics.median(float(item[phase]["oracle"][percentile]) for item in items)
                candidate = statistics.median(float(item[phase]["candidate"][percentile]) for item in items)
                ratio = candidate / oracle if oracle > 0.0 else 0.0
                phase_result[percentile] = {
                    "oracleMedian": oracle,
                    "candidateMedian": candidate,
                    "candidateOverOracle": ratio,
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
                "geometricMeanCandidateOverOracle": geometric_mean(ratios),
                "medianCandidateOverOracle": statistics.median(ratios),
                "minimumCandidateOverOracle": min(ratios),
                "maximumCandidateOverOracle": max(ratios),
                "candidateFasterCases": faster_counts[phase][percentile],
                "caseCount": len(ratios),
            }

    return {
        "schema": SCHEMA,
        "runCount": len(runs),
        "sampleRate": runs[0]["sampleRate"],
        "blockSize": runs[0]["blockSize"],
        "modalKernelBackend": runs[0]["modalKernelBackend"],
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
                "oracle_median_us",
                "candidate_median_us",
                "candidate_over_oracle",
                "max_abs_error",
                "minimum_snr_db",
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
                            item["oracleMedian"],
                            item["candidateMedian"],
                            item["candidateOverOracle"],
                            case["audioError"]["maximumMaxAbs"],
                            case["audioError"]["minimumSnrDb"],
                        ]
                    )


def write_report(path: Path, summary: dict[str, Any]) -> None:
    lines = [
        "# BRK Modal P4.7C terminal-tail benchmark",
        "",
        f"Repeated runs: `{summary['runCount']}`  ",
        f"Audio geometry: `{summary['sampleRate']} Hz / {summary['blockSize']} frames`  ",
        f"Modal backend: `{summary['modalKernelBackend']}`  ",
        "",
        "Ratios below 1.0 favor Conservative tail sleeping. Active and decaying phases should stay near 1.0; the intended gain is in mostly-silent terminal tails.",
        "",
        "| Phase | Statistic | Geomean Candidate/Oracle | Median | Faster cases |",
        "| --- | --- | ---: | ---: | ---: |",
    ]
    for phase in PHASES:
        for percentile in ("p50Microseconds", "p95Microseconds", "p99Microseconds"):
            item = summary["aggregateRatios"][phase][percentile]
            lines.append(
                f"| {phase} | {percentile} | {item['geometricMeanCandidateOverOracle']:.4f} | "
                f"{item['medianCandidateOverOracle']:.4f} | "
                f"{item['candidateFasterCases']}/{item['caseCount']} |"
            )
    lines.extend(["", "## Audio error", ""])
    for case in summary["cases"]:
        error = case["audioError"]
        lines.append(
            f"- `{case['id']}`: max `{error['maximumMaxAbs']:.3e}`, "
            f"median RMS `{error['medianRms']:.3e}`, minimum SNR `{error['minimumSnrDb']:.2f} dB`."
        )
    lines.extend(
        [
            "",
            "The no-sleep oracle remains the default. Candidate timings do not count modal or voice reduction as an optimization.",
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
    (args.output_dir / "p47c-tail-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    write_csv(args.output_dir / "p47c-tail-cases.csv", summary)
    write_report(args.output_dir / "REPORT.md", summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
