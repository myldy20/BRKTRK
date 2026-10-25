#!/usr/bin/env python3
"""Compare matched RipplerX and BRK Modal PCM WAV captures.

The report intentionally keeps two views:
- raw: no onset alignment, gain matching or normalization;
- diagnostic: onset aligned and level matched over the first 500 ms.

Only Python's standard library is required. PCM 16/24/32-bit WAV is supported.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import struct
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass
class Audio:
    rate: int
    channels: list[list[float]]

    @property
    def frames(self) -> int:
        return len(self.channels[0]) if self.channels else 0

    def mono(self) -> list[float]:
        if not self.channels:
            return []
        count = len(self.channels)
        return [sum(channel[index] for channel in self.channels) / count for index in range(self.frames)]


def decode_pcm(raw: bytes, width: int) -> Iterable[float]:
    if width == 2:
        for (value,) in struct.iter_unpack("<h", raw):
            yield value / 32768.0
    elif width == 3:
        for offset in range(0, len(raw), 3):
            value = raw[offset] | (raw[offset + 1] << 8) | (raw[offset + 2] << 16)
            if value & 0x800000:
                value -= 1 << 24
            yield value / 8388608.0
    elif width == 4:
        for (value,) in struct.iter_unpack("<i", raw):
            yield value / 2147483648.0
    else:
        raise ValueError(f"unsupported PCM width: {width * 8} bit")


def read_wav(path: Path) -> Audio:
    with wave.open(str(path), "rb") as source:
        if source.getcomptype() != "NONE":
            raise ValueError(f"compressed WAV is unsupported: {path}")
        channel_count = source.getnchannels()
        width = source.getsampwidth()
        frame_count = source.getnframes()
        rate = source.getframerate()
        decoded = list(decode_pcm(source.readframes(frame_count), width))
    channels = [[] for _ in range(channel_count)]
    for index, sample in enumerate(decoded):
        channels[index % channel_count].append(sample)
    return Audio(rate=rate, channels=channels)


def resample_linear(samples: list[float], source_rate: int, target_rate: int) -> list[float]:
    if source_rate == target_rate:
        return samples
    if not samples:
        return []
    target_frames = max(1, round(len(samples) * target_rate / source_rate))
    scale = source_rate / target_rate
    result = [0.0] * target_frames
    for index in range(target_frames):
        position = index * scale
        left = min(len(samples) - 1, int(position))
        right = min(len(samples) - 1, left + 1)
        fraction = position - left
        result[index] = samples[left] * (1.0 - fraction) + samples[right] * fraction
    return result


def peak(samples: list[float]) -> float:
    return max((abs(value) for value in samples), default=0.0)


def rms(samples: list[float]) -> float:
    if not samples:
        return 0.0
    return math.sqrt(sum(value * value for value in samples) / len(samples))


def db_ratio(numerator: float, denominator: float) -> float:
    return 20.0 * math.log10(max(1.0e-12, numerator) / max(1.0e-12, denominator))


def onset(samples: list[float]) -> int:
    reference_peak = peak(samples)
    threshold = max(1.0e-5, reference_peak * 0.01)
    for index, value in enumerate(samples):
        if abs(value) >= threshold:
            return index
    return 0


def correlation(first: list[float], second: list[float]) -> float:
    if not first or len(first) != len(second):
        return 0.0
    mean_first = sum(first) / len(first)
    mean_second = sum(second) / len(second)
    numerator = sum((a - mean_first) * (b - mean_second) for a, b in zip(first, second))
    energy_first = sum((value - mean_first) ** 2 for value in first)
    energy_second = sum((value - mean_second) ** 2 for value in second)
    denominator = math.sqrt(energy_first * energy_second)
    return numerator / denominator if denominator > 1.0e-20 else 0.0


def normalized_rmse(reference: list[float], candidate: list[float]) -> float:
    if not reference or len(reference) != len(candidate):
        return 0.0
    error = math.sqrt(sum((a - b) ** 2 for a, b in zip(reference, candidate)) / len(reference))
    return error / rms(reference) if rms(reference) > 1.0e-12 else 0.0


def fft(values: list[complex]) -> None:
    size = len(values)
    swap = 0
    for index in range(1, size):
        bit = size >> 1
        while swap & bit:
            swap ^= bit
            bit >>= 1
        swap ^= bit
        if index < swap:
            values[index], values[swap] = values[swap], values[index]
    length = 2
    while length <= size:
        angle = -2.0 * math.pi / length
        step = complex(math.cos(angle), math.sin(angle))
        for offset in range(0, size, length):
            weight = 1.0 + 0.0j
            half = length // 2
            for index in range(half):
                even = values[offset + index]
                odd = values[offset + index + half] * weight
                values[offset + index] = even + odd
                values[offset + index + half] = even - odd
                weight *= step
        length <<= 1


def spectrum(samples: list[float], rate: int, start_seconds: float = 0.005) -> list[float]:
    size = 16384
    start = min(len(samples), int(rate * start_seconds))
    values: list[complex] = []
    for index in range(size):
        sample = samples[start + index] if start + index < len(samples) else 0.0
        window = 0.5 - 0.5 * math.cos(2.0 * math.pi * index / (size - 1))
        values.append(complex(sample * window, 0.0))
    fft(values)
    return [abs(values[index]) for index in range(1, size // 2)]


def centroid_from_spectrum(magnitudes: list[float], rate: int) -> float:
    total = sum(magnitudes)
    if total <= 1.0e-20:
        return 0.0
    size = (len(magnitudes) + 1) * 2
    return sum((index + 1) * rate / size * magnitude for index, magnitude in enumerate(magnitudes)) / total


def log_spectral_distance(reference: list[float], candidate: list[float]) -> float:
    if not reference or len(reference) != len(candidate):
        return 0.0
    differences = []
    for ref, cand in zip(reference, candidate):
        ref_db = 20.0 * math.log10(max(ref, 1.0e-12))
        cand_db = 20.0 * math.log10(max(cand, 1.0e-12))
        differences.append((ref_db - cand_db) ** 2)
    return math.sqrt(sum(differences) / len(differences))


def window_rms(samples: list[float], rate: int, start: float, end: float) -> float:
    begin = min(len(samples), int(start * rate))
    finish = min(len(samples), int(end * rate))
    return rms(samples[begin:finish])


def decay_t30(samples: list[float], rate: int, release_seconds: float = 0.8) -> float:
    release = min(len(samples), int(rate * release_seconds))
    if release + 2 >= len(samples):
        return 0.0
    integrated = [0.0] * (len(samples) - release + 1)
    for index in range(len(samples) - 1, release - 1, -1):
        integrated[index - release] = integrated[index - release + 1] + samples[index] ** 2
    reference = integrated[0]
    if reference <= 1.0e-20:
        return 0.0

    def crossing(decibels: float) -> float:
        target = reference * 10.0 ** (decibels / 10.0)
        for index, value in enumerate(integrated[:-1]):
            if value <= target:
                return index / rate
        return 0.0

    t5 = crossing(-5.0)
    t35 = crossing(-35.0)
    return 2.0 * (t35 - t5) if t35 > t5 else 0.0


def prepare_raw(reference: list[float], candidate: list[float], limit: int) -> tuple[list[float], list[float]]:
    length = min(len(reference), len(candidate), limit)
    return reference[:length], candidate[:length]


def prepare_diagnostic(
    reference: list[float], candidate: list[float], rate: int, limit: int
) -> tuple[list[float], list[float], int, float]:
    ref_onset = onset(reference)
    candidate_onset = onset(candidate)
    aligned_reference = reference[ref_onset:]
    aligned_candidate = candidate[candidate_onset:]
    length = min(len(aligned_reference), len(aligned_candidate), limit)
    aligned_reference = aligned_reference[:length]
    aligned_candidate = aligned_candidate[:length]
    window = min(length, int(rate * 0.5))
    reference_rms = rms(aligned_reference[:window])
    candidate_rms = rms(aligned_candidate[:window])
    gain = reference_rms / candidate_rms if candidate_rms > 1.0e-12 else 1.0
    return aligned_reference, [value * gain for value in aligned_candidate], candidate_onset - ref_onset, gain


def compare_case(reference_path: Path, candidate_path: Path, release_seconds: float) -> dict[str, float | int]:
    reference_audio = read_wav(reference_path)
    candidate_audio = read_wav(candidate_path)
    reference = reference_audio.mono()
    candidate = resample_linear(candidate_audio.mono(), candidate_audio.rate, reference_audio.rate)
    analysis_limit = reference_audio.rate * 3
    raw_reference, raw_candidate = prepare_raw(reference, candidate, analysis_limit)
    diagnostic_reference, diagnostic_candidate, onset_delta, gain = prepare_diagnostic(
        reference, candidate, reference_audio.rate, analysis_limit
    )

    raw_reference_spectrum = spectrum(raw_reference, reference_audio.rate)
    raw_candidate_spectrum = spectrum(raw_candidate, reference_audio.rate)
    diagnostic_reference_spectrum = spectrum(diagnostic_reference, reference_audio.rate)
    diagnostic_candidate_spectrum = spectrum(diagnostic_candidate, reference_audio.rate)
    raw_ref_t30 = decay_t30(raw_reference, reference_audio.rate, release_seconds)
    raw_candidate_t30 = decay_t30(raw_candidate, reference_audio.rate, release_seconds)

    null = [a - b for a, b in zip(diagnostic_reference, diagnostic_candidate)]
    return {
        "reference_rate": reference_audio.rate,
        "onset_delta_samples": onset_delta,
        "raw_reference_peak": peak(raw_reference),
        "raw_candidate_peak": peak(raw_candidate),
        "raw_peak_delta_db": db_ratio(peak(raw_candidate), peak(raw_reference)),
        "raw_reference_rms": rms(raw_reference),
        "raw_candidate_rms": rms(raw_candidate),
        "raw_rms_delta_db": db_ratio(rms(raw_candidate), rms(raw_reference)),
        "raw_correlation": correlation(raw_reference, raw_candidate),
        "raw_normalized_rmse": normalized_rmse(raw_reference, raw_candidate),
        "raw_reference_centroid_hz": centroid_from_spectrum(raw_reference_spectrum, reference_audio.rate),
        "raw_candidate_centroid_hz": centroid_from_spectrum(raw_candidate_spectrum, reference_audio.rate),
        "raw_log_spectral_distance_db": log_spectral_distance(raw_reference_spectrum, raw_candidate_spectrum),
        "raw_reference_t30_seconds": raw_ref_t30,
        "raw_candidate_t30_seconds": raw_candidate_t30,
        "raw_t30_delta_seconds": raw_candidate_t30 - raw_ref_t30,
        "diagnostic_candidate_gain": gain,
        "diagnostic_correlation": correlation(diagnostic_reference, diagnostic_candidate),
        "diagnostic_normalized_rmse": normalized_rmse(diagnostic_reference, diagnostic_candidate),
        "diagnostic_null_rms_db_relative": db_ratio(rms(null), rms(diagnostic_reference)),
        "diagnostic_transient_delta_db": db_ratio(
            window_rms(diagnostic_candidate, reference_audio.rate, 0.0, 0.05),
            window_rms(diagnostic_reference, reference_audio.rate, 0.0, 0.05),
        ),
        "diagnostic_body_delta_db": db_ratio(
            window_rms(diagnostic_candidate, reference_audio.rate, 0.05, 0.5),
            window_rms(diagnostic_reference, reference_audio.rate, 0.05, 0.5),
        ),
        "diagnostic_tail_delta_db": db_ratio(
            window_rms(diagnostic_candidate, reference_audio.rate, 1.0, 2.0),
            window_rms(diagnostic_reference, reference_audio.rate, 1.0, 2.0),
        ),
        "diagnostic_reference_centroid_hz": centroid_from_spectrum(
            diagnostic_reference_spectrum, reference_audio.rate
        ),
        "diagnostic_candidate_centroid_hz": centroid_from_spectrum(
            diagnostic_candidate_spectrum, reference_audio.rate
        ),
        "diagnostic_log_spectral_distance_db": log_spectral_distance(
            diagnostic_reference_spectrum, diagnostic_candidate_spectrum
        ),
    }


def summarize(rows: list[dict[str, str | float | int]]) -> dict[str, object]:
    numeric_keys = [
        "raw_peak_delta_db",
        "raw_rms_delta_db",
        "raw_correlation",
        "raw_normalized_rmse",
        "raw_log_spectral_distance_db",
        "raw_t30_delta_seconds",
        "diagnostic_correlation",
        "diagnostic_normalized_rmse",
        "diagnostic_null_rms_db_relative",
        "diagnostic_transient_delta_db",
        "diagnostic_body_delta_db",
        "diagnostic_tail_delta_db",
        "diagnostic_log_spectral_distance_db",
    ]
    metrics: dict[str, object] = {}
    for key in numeric_keys:
        values = [float(row[key]) for row in rows]
        metrics[key] = {
            "mean": statistics.fmean(values),
            "median": statistics.median(values),
            "minimum": min(values),
            "maximum": max(values),
        }
    worst_nrmse = sorted(rows, key=lambda row: float(row["diagnostic_normalized_rmse"]), reverse=True)[:10]
    worst_spectral = sorted(rows, key=lambda row: float(row["diagnostic_log_spectral_distance_db"]), reverse=True)[:10]
    return {
        "schema": "brk-modal-p45-audio-comparison-summary-v1",
        "caseCount": len(rows),
        "metrics": metrics,
        "worstDiagnosticNrmse": [row["case_id"] for row in worst_nrmse],
        "worstDiagnosticSpectralDistance": [row["case_id"] for row in worst_spectral],
        "claim": "Measured structural deviation only; this report does not certify perceptual identity.",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, nargs="?", default=Path("parity-output"))
    args = parser.parse_args()
    root: Path = args.root
    cases_path = root / "cases.csv"
    reference_dir = root / "reference"
    candidate_dir = root / "candidate"
    if not cases_path.exists():
        raise SystemExit(f"missing {cases_path}")

    rows: list[dict[str, str | float | int]] = []
    with cases_path.open(newline="", encoding="utf-8") as source:
        for case in csv.DictReader(source):
            reference = reference_dir / case["reference_filename"]
            candidate = candidate_dir / case["candidate_filename"]
            if not reference.exists():
                print(f"SKIP {case['case_id']}: missing {reference}")
                continue
            if not candidate.exists():
                print(f"SKIP {case['case_id']}: missing {candidate}")
                continue
            release_seconds = int(case.get("note_off_frame", "38400")) / int(case.get("sample_rate", "48000"))
            result = compare_case(reference, candidate, release_seconds)
            row: dict[str, str | float | int] = {
                "case_id": case["case_id"],
                "program_index": case.get("program_index", ""),
                "program_name": case.get("program_name", ""),
                "key": case.get("key", ""),
                "velocity": case.get("velocity", ""),
            }
            row.update(result)
            rows.append(row)
            print(
                f"{case['case_id']}: raw_rms={float(result['raw_rms_delta_db']):+.2f} dB "
                f"diag_corr={float(result['diagnostic_correlation']):.4f} "
                f"diag_nrmse={float(result['diagnostic_normalized_rmse']):.4f} "
                f"lsd={float(result['diagnostic_log_spectral_distance_db']):.2f} dB"
            )

    if not rows:
        print("No matched reference pairs found.")
        return 2

    fieldnames = list(rows[0].keys())
    with (root / "comparison.csv").open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    (root / "comparison-summary.json").write_text(
        json.dumps(summarize(rows), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"compared_case_count={len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
