#!/usr/bin/env python3
"""Analyze P4.7A Ride2/Crash ensembles without using single-take correlation as a gate."""

from __future__ import annotations

import argparse
import csv
import json
import math
import wave
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np

EPS = 1.0e-30
FFT_SIZE = 4096
HOP_SIZE = 2048
RMS_WINDOW_SECONDS = 0.1
BANDS = (
    (20.0, 100.0),
    (100.0, 250.0),
    (250.0, 500.0),
    (500.0, 1000.0),
    (1000.0, 2000.0),
    (2000.0, 4000.0),
    (4000.0, 8000.0),
    (8000.0, 12000.0),
    (12000.0, 20000.0),
)


@dataclass(frozen=True)
class Case:
    case_id: str
    model: str
    program_index: int
    seed_index: int
    seed_decimal: int
    seed_hex: str
    note_off_frame: int
    sample_rate: int
    upstream_filename: str
    brk_filename: str


@dataclass
class Audio:
    sample_rate: int
    stereo: np.ndarray
    mono: np.ndarray


@dataclass
class TakeMetrics:
    peak: float
    rms: float
    energy: float
    tail_energy: float
    late_tail_energy: float
    spectral_flatness: float
    spectral_density: float
    edc_t10_seconds: float | None
    edc_t20_seconds: float | None
    edc_t30_seconds: float | None
    power: np.ndarray
    normalized_power_db: np.ndarray
    window_rms_db: np.ndarray
    band_normalized_db: dict[str, float]


def read_cases(path: Path) -> list[Case]:
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    if not rows:
        raise ValueError("P4.7A plan is empty")
    return [
        Case(
            case_id=row["case_id"],
            model=row["model"],
            program_index=int(row["program_index"]),
            seed_index=int(row["seed_index"]),
            seed_decimal=int(row["seed_decimal"]),
            seed_hex=row["seed_hex"],
            note_off_frame=int(row["note_off_frame"]),
            sample_rate=int(row["sample_rate"]),
            upstream_filename=row["upstream_filename"],
            brk_filename=row["brk_filename"],
        )
        for row in rows
    ]


def read_wav(path: Path) -> Audio:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        frame_count = handle.getnframes()
        if channels != 2 or sample_width != 4:
            raise ValueError(f"expected stereo 32-bit PCM WAV: {path}")
        raw = handle.readframes(frame_count)
    stereo = np.frombuffer(raw, dtype="<i4").astype(np.float64).reshape(-1, 2) / 2147483647.0
    mono = stereo.mean(axis=1)
    return Audio(sample_rate=sample_rate, stereo=stereo, mono=mono)


def welch_power(samples: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    if samples.size < FFT_SIZE:
        samples = np.pad(samples, (0, FFT_SIZE - samples.size))
    starts = list(range(0, max(1, samples.size - FFT_SIZE + 1), HOP_SIZE))
    if not starts or starts[-1] + FFT_SIZE < samples.size:
        starts.append(max(0, samples.size - FFT_SIZE))
    window = np.hanning(FFT_SIZE)
    scale = float(np.sum(window * window))
    spectra = []
    for start in starts:
        segment = samples[start : start + FFT_SIZE]
        if segment.size < FFT_SIZE:
            segment = np.pad(segment, (0, FFT_SIZE - segment.size))
        spectrum = np.fft.rfft(segment * window)
        spectra.append((np.abs(spectrum) ** 2) / max(scale, EPS))
    power = np.mean(np.asarray(spectra), axis=0)
    frequencies = np.fft.rfftfreq(FFT_SIZE, 1.0 / sample_rate)
    return frequencies, power


def rms_db(samples: np.ndarray) -> float:
    return 20.0 * math.log10(max(float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0, EPS))


def edc_crossing_seconds(samples: np.ndarray, sample_rate: int, threshold_db: float) -> float | None:
    if samples.size == 0:
        return None
    energy = samples * samples
    reverse = np.cumsum(energy[::-1])[::-1]
    if reverse[0] <= EPS:
        return None
    edc_db = 10.0 * np.log10(np.maximum(reverse / reverse[0], EPS))
    indices = np.flatnonzero(edc_db <= threshold_db)
    if indices.size == 0:
        return None
    return float(indices[0]) / float(sample_rate)


def band_name(low: float, high: float) -> str:
    def label(value: float) -> str:
        return f"{value / 1000.0:g}k" if value >= 1000.0 else f"{value:g}"
    return f"{label(low)}-{label(high)}Hz"


def calculate_metrics(audio: Audio, note_off_frame: int) -> tuple[TakeMetrics, np.ndarray]:
    mono = audio.mono
    sample_rate = audio.sample_rate
    frequencies, power = welch_power(mono, sample_rate)
    valid = (frequencies >= 20.0) & (frequencies <= min(20000.0, 0.49 * sample_rate))
    normalized_power = power / max(float(np.sum(power[valid])), EPS)
    normalized_power_db = 10.0 * np.log10(np.maximum(normalized_power, EPS))
    valid_power = normalized_power[valid]
    spectral_flatness = float(np.exp(np.mean(np.log(np.maximum(valid_power, EPS)))) / max(float(np.mean(valid_power)), EPS))
    relative_db = 10.0 * np.log10(np.maximum(valid_power / max(float(np.max(valid_power)), EPS), EPS))
    spectral_density = float(np.mean(relative_db >= -40.0))

    window_frames = max(1, int(round(RMS_WINDOW_SECONDS * sample_rate)))
    window_values = []
    for start in range(0, mono.size, window_frames):
        window_values.append(rms_db(mono[start : min(start + window_frames, mono.size)]))
    window_rms = np.asarray(window_values, dtype=np.float64)

    release = min(max(note_off_frame, 0), mono.size)
    late_start = min(mono.size, release + int(round(0.7 * sample_rate)))
    band_values: dict[str, float] = {}
    for low, high in BANDS:
        mask = (frequencies >= low) & (frequencies < min(high, 0.5 * sample_rate))
        value = float(np.sum(normalized_power[mask]))
        band_values[band_name(low, high)] = 10.0 * math.log10(max(value, EPS))

    release_samples = mono[release:]
    metrics = TakeMetrics(
        peak=float(np.max(np.abs(audio.stereo))) if audio.stereo.size else 0.0,
        rms=float(np.sqrt(np.mean(mono * mono))) if mono.size else 0.0,
        energy=float(np.sum(mono * mono) / sample_rate),
        tail_energy=float(np.sum(release_samples * release_samples) / sample_rate),
        late_tail_energy=float(np.sum(mono[late_start:] * mono[late_start:]) / sample_rate),
        spectral_flatness=spectral_flatness,
        spectral_density=spectral_density,
        edc_t10_seconds=edc_crossing_seconds(release_samples, sample_rate, -10.0),
        edc_t20_seconds=edc_crossing_seconds(release_samples, sample_rate, -20.0),
        edc_t30_seconds=edc_crossing_seconds(release_samples, sample_rate, -30.0),
        power=power,
        normalized_power_db=normalized_power_db,
        window_rms_db=window_rms,
        band_normalized_db=band_values,
    )
    return metrics, frequencies


def finite_values(values: Iterable[float | None]) -> np.ndarray:
    return np.asarray([float(value) for value in values if value is not None and math.isfinite(float(value))], dtype=np.float64)


def distribution(values: Iterable[float | None]) -> dict[str, float | int | None]:
    array = finite_values(values)
    if array.size == 0:
        return {"count": 0, "mean": None, "stddev": None, "p05": None, "median": None, "p95": None}
    return {
        "count": int(array.size),
        "mean": float(np.mean(array)),
        "stddev": float(np.std(array, ddof=1)) if array.size > 1 else 0.0,
        "p05": float(np.percentile(array, 5.0)),
        "median": float(np.percentile(array, 50.0)),
        "p95": float(np.percentile(array, 95.0)),
    }


def difference_stats(upstream: Iterable[float | None], brk: Iterable[float | None]) -> dict[str, float | int | None]:
    left = finite_values(upstream)
    right = finite_values(brk)
    if left.size == 0 or right.size == 0:
        return {"upstreamCount": int(left.size), "brkCount": int(right.size), "meanDeltaBrkMinusUpstream": None,
                "pooledStddev": None, "standardizedDifference": None, "confidence95Low": None, "confidence95High": None}
    mean_delta = float(np.mean(right) - np.mean(left))
    left_var = float(np.var(left, ddof=1)) if left.size > 1 else 0.0
    right_var = float(np.var(right, ddof=1)) if right.size > 1 else 0.0
    denominator = max(1, left.size + right.size - 2)
    pooled_variance = ((left.size - 1) * left_var + (right.size - 1) * right_var) / denominator
    pooled_stddev = math.sqrt(max(pooled_variance, 0.0))
    standard = mean_delta / pooled_stddev if pooled_stddev > 1.0e-15 else (0.0 if abs(mean_delta) <= 1.0e-15 else None)
    standard_error = math.sqrt(left_var / left.size + right_var / right.size)
    critical = 2.04  # conservative normal/t approximation for two 16-take ensembles
    return {
        "upstreamCount": int(left.size),
        "brkCount": int(right.size),
        "meanDeltaBrkMinusUpstream": mean_delta,
        "pooledStddev": pooled_stddev,
        "standardizedDifference": standard,
        "confidence95Low": mean_delta - critical * standard_error,
        "confidence95High": mean_delta + critical * standard_error,
    }


def metric_value(metrics: TakeMetrics, name: str) -> float | None:
    return getattr(metrics, name)


def write_csv(path: Path, fieldnames: list[str], rows: Iterable[dict[str, object]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_listening_artifact(
    cases: list[Case],
    audios: dict[tuple[str, str], Audio],
    metrics: dict[tuple[str, str], TakeMetrics],
    output_dir: Path,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "brk-modal-p47a-listening.wav"
    cues: list[dict[str, object]] = []
    chunks: list[np.ndarray] = []
    cursor = 0
    sample_rate = cases[0].sample_rate
    silence = np.zeros((int(round(0.10 * sample_rate)), 2), dtype=np.float64)

    for model in ("Ride2", "Crash"):
        model_cases = sorted((item for item in cases if item.model == model), key=lambda item: item.seed_index)
        ranked = sorted(model_cases, key=lambda item: metrics[(item.case_id, "upstream")].energy)
        selected = [("low-energy", ranked[0]), ("median-energy", ranked[len(ranked) // 2]), ("high-energy", ranked[-1])]
        for selection, item in selected:
            for engine in ("upstream", "brk"):
                audio = audios[(item.case_id, engine)]
                body_end = min(audio.stereo.shape[0], int(round(0.65 * sample_rate)))
                tail_start = min(audio.stereo.shape[0], int(round(1.30 * sample_rate)))
                tail_end = min(audio.stereo.shape[0], int(round(2.30 * sample_rate)))
                clip = np.concatenate((audio.stereo[:body_end], silence[: int(0.05 * sample_rate)], audio.stereo[tail_start:tail_end]), axis=0)
                start = cursor
                chunks.append(clip)
                cursor += clip.shape[0]
                cues.append(
                    {
                        "start_seconds": start / sample_rate,
                        "end_seconds": cursor / sample_rate,
                        "model": model,
                        "selection": selection,
                        "engine": engine,
                        "seed_index": item.seed_index,
                        "seed_hex": item.seed_hex,
                        "listen_for": "strike/body then 1.3-2.3 s tail; compare paired engine cues",
                    }
                )
                chunks.append(silence)
                cursor += silence.shape[0]

    assembled = np.concatenate(chunks, axis=0) if chunks else np.zeros((1, 2), dtype=np.float64)
    quantized = np.rint(np.clip(assembled, -1.0, 1.0) * 2147483647.0).astype("<i4")
    with wave.open(str(output_path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(4)
        handle.setframerate(sample_rate)
        handle.writeframes(quantized.tobytes())
    write_csv(
        output_dir / "brk-modal-p47a-listening-cues.csv",
        ["start_seconds", "end_seconds", "model", "selection", "engine", "seed_index", "seed_hex", "listen_for"],
        cues,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--upstream-dir", required=True, type=Path)
    parser.add_argument("--brk-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--listening-dir", required=True, type=Path)
    args = parser.parse_args()

    cases = read_cases(args.plan)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    audios: dict[tuple[str, str], Audio] = {}
    metrics: dict[tuple[str, str], TakeMetrics] = {}
    frequencies_by_model: dict[str, np.ndarray] = {}

    per_take_rows: list[dict[str, object]] = []
    rms_rows: list[dict[str, object]] = []
    for item in cases:
        for engine, root, filename in (
            ("upstream", args.upstream_dir, item.upstream_filename),
            ("brk", args.brk_dir, item.brk_filename),
        ):
            audio = read_wav(root / filename)
            if audio.sample_rate != item.sample_rate:
                raise ValueError(f"sample rate mismatch for {item.case_id} {engine}")
            take, frequencies = calculate_metrics(audio, item.note_off_frame)
            audios[(item.case_id, engine)] = audio
            metrics[(item.case_id, engine)] = take
            frequencies_by_model[item.model] = frequencies
            per_take_rows.append(
                {
                    "case_id": item.case_id,
                    "model": item.model,
                    "program_index": item.program_index,
                    "engine": engine,
                    "seed_index": item.seed_index,
                    "seed_decimal": item.seed_decimal,
                    "seed_hex": item.seed_hex,
                    "peak": take.peak,
                    "rms": take.rms,
                    "energy": take.energy,
                    "tail_energy": take.tail_energy,
                    "late_tail_energy": take.late_tail_energy,
                    "spectral_flatness": take.spectral_flatness,
                    "spectral_density_fraction_above_minus40db": take.spectral_density,
                    "edc_t10_seconds": take.edc_t10_seconds,
                    "edc_t20_seconds": take.edc_t20_seconds,
                    "edc_t30_seconds": take.edc_t30_seconds,
                }
            )
            for index, value in enumerate(take.window_rms_db):
                rms_rows.append(
                    {
                        "case_id": item.case_id,
                        "model": item.model,
                        "engine": engine,
                        "seed_index": item.seed_index,
                        "seed_hex": item.seed_hex,
                        "window_index": index,
                        "start_seconds": index * RMS_WINDOW_SECONDS,
                        "end_seconds": (index + 1) * RMS_WINDOW_SECONDS,
                        "rms_dbfs": value,
                    }
                )

    write_csv(
        args.output_dir / "per-take-metrics.csv",
        ["case_id", "model", "program_index", "engine", "seed_index", "seed_decimal", "seed_hex", "peak", "rms",
         "energy", "tail_energy", "late_tail_energy", "spectral_flatness", "spectral_density_fraction_above_minus40db",
         "edc_t10_seconds", "edc_t20_seconds", "edc_t30_seconds"],
        per_take_rows,
    )
    write_csv(
        args.output_dir / "windowed-rms-envelope.csv",
        ["case_id", "model", "engine", "seed_index", "seed_hex", "window_index", "start_seconds", "end_seconds", "rms_dbfs"],
        rms_rows,
    )

    grouped: dict[tuple[str, str], list[TakeMetrics]] = defaultdict(list)
    for item in cases:
        for engine in ("upstream", "brk"):
            grouped[(item.model, engine)].append(metrics[(item.case_id, engine)])

    spectrum_rows: list[dict[str, object]] = []
    band_rows: list[dict[str, object]] = []
    model_summaries: dict[str, object] = {}
    summary_metric_names = (
        "peak", "rms", "energy", "tail_energy", "late_tail_energy",
        "spectral_flatness", "spectral_density", "edc_t10_seconds", "edc_t20_seconds", "edc_t30_seconds",
    )
    model_summary_rows: list[dict[str, object]] = []

    for model in ("Ride2", "Crash"):
        upstream_takes = grouped[(model, "upstream")]
        brk_takes = grouped[(model, "brk")]
        frequencies = frequencies_by_model[model]
        upstream_power = np.asarray([take.power for take in upstream_takes])
        brk_power = np.asarray([take.power for take in brk_takes])
        upstream_norm_db = np.asarray([take.normalized_power_db for take in upstream_takes])
        brk_norm_db = np.asarray([take.normalized_power_db for take in brk_takes])
        mean_upstream_power = np.mean(upstream_power, axis=0)
        mean_brk_power = np.mean(brk_power, axis=0)
        mean_upstream_norm_db = np.mean(upstream_norm_db, axis=0)
        mean_brk_norm_db = np.mean(brk_norm_db, axis=0)
        std_upstream_norm_db = np.std(upstream_norm_db, axis=0, ddof=1)
        std_brk_norm_db = np.std(brk_norm_db, axis=0, ddof=1)
        delta = mean_brk_norm_db - mean_upstream_norm_db
        pooled = np.sqrt((std_upstream_norm_db**2 + std_brk_norm_db**2) / 2.0)
        effect = np.divide(delta, pooled, out=np.zeros_like(delta), where=pooled > 1.0e-12)
        se = np.sqrt(std_upstream_norm_db**2 / len(upstream_takes) + std_brk_norm_db**2 / len(brk_takes))
        ci_low = delta - 2.04 * se
        ci_high = delta + 2.04 * se
        for index, frequency in enumerate(frequencies):
            if frequency < 20.0 or frequency > min(20000.0, 0.49 * cases[0].sample_rate):
                continue
            spectrum_rows.append(
                {
                    "model": model,
                    "frequency_hz": frequency,
                    "upstream_ensemble_power_db": 10.0 * math.log10(max(float(mean_upstream_power[index]), EPS)),
                    "brk_ensemble_power_db": 10.0 * math.log10(max(float(mean_brk_power[index]), EPS)),
                    "upstream_mean_normalized_power_db": mean_upstream_norm_db[index],
                    "brk_mean_normalized_power_db": mean_brk_norm_db[index],
                    "normalized_delta_db_brk_minus_upstream": delta[index],
                    "upstream_rng_stddev_db": std_upstream_norm_db[index],
                    "brk_rng_stddev_db": std_brk_norm_db[index],
                    "pooled_standardized_difference": effect[index],
                    "delta_confidence95_low_db": ci_low[index],
                    "delta_confidence95_high_db": ci_high[index],
                }
            )

        model_metric_summary: dict[str, object] = {}
        for metric_name in summary_metric_names:
            upstream_values = [metric_value(take, metric_name) for take in upstream_takes]
            brk_values = [metric_value(take, metric_name) for take in brk_takes]
            stats = difference_stats(upstream_values, brk_values)
            model_metric_summary[metric_name] = {
                "rngVariation": {
                    "upstream": distribution(upstream_values),
                    "brk": distribution(brk_values),
                },
                "modalEnvelopeDifference": stats,
            }
            model_summary_rows.append(
                {
                    "model": model,
                    "metric": metric_name,
                    "upstream_mean": distribution(upstream_values)["mean"],
                    "upstream_rng_stddev": distribution(upstream_values)["stddev"],
                    "brk_mean": distribution(brk_values)["mean"],
                    "brk_rng_stddev": distribution(brk_values)["stddev"],
                    **stats,
                }
            )

        notable_positive_bands: list[dict[str, object]] = []
        notable_negative_bands: list[dict[str, object]] = []
        for low, high in BANDS:
            name = band_name(low, high)
            up_values = [take.band_normalized_db[name] for take in upstream_takes]
            brk_values = [take.band_normalized_db[name] for take in brk_takes]
            stats = difference_stats(up_values, brk_values)
            row = {
                "model": model,
                "band": name,
                "low_hz": low,
                "high_hz": high,
                "upstream_mean_normalized_energy_db": distribution(up_values)["mean"],
                "upstream_rng_stddev_db": distribution(up_values)["stddev"],
                "brk_mean_normalized_energy_db": distribution(brk_values)["mean"],
                "brk_rng_stddev_db": distribution(brk_values)["stddev"],
                **stats,
            }
            band_rows.append(row)
            low_ci = stats["confidence95Low"]
            high_ci = stats["confidence95High"]
            if low_ci is not None and low_ci > 0.0:
                notable_positive_bands.append({"band": name, **stats})
            if high_ci is not None and high_ci < 0.0:
                notable_negative_bands.append({"band": name, **stats})

        model_summaries[model] = {
            "takeCountPerEngine": len(upstream_takes),
            "metrics": model_metric_summary,
            "spectrum": {
                "fftSize": FFT_SIZE,
                "hopSize": HOP_SIZE,
                "notablePositiveBands": notable_positive_bands,
                "notableNegativeBands": notable_negative_bands,
            },
        }

    write_csv(
        args.output_dir / "averaged-power-spectrum.csv",
        ["model", "frequency_hz", "upstream_ensemble_power_db", "brk_ensemble_power_db",
         "upstream_mean_normalized_power_db", "brk_mean_normalized_power_db", "normalized_delta_db_brk_minus_upstream",
         "upstream_rng_stddev_db", "brk_rng_stddev_db", "pooled_standardized_difference",
         "delta_confidence95_low_db", "delta_confidence95_high_db"],
        spectrum_rows,
    )
    write_csv(
        args.output_dir / "spectral-bands.csv",
        ["model", "band", "low_hz", "high_hz", "upstream_mean_normalized_energy_db", "upstream_rng_stddev_db",
         "brk_mean_normalized_energy_db", "brk_rng_stddev_db", "upstreamCount", "brkCount",
         "meanDeltaBrkMinusUpstream", "pooledStddev", "standardizedDifference", "confidence95Low", "confidence95High"],
        band_rows,
    )
    write_csv(
        args.output_dir / "model-summary.csv",
        ["model", "metric", "upstream_mean", "upstream_rng_stddev", "brk_mean", "brk_rng_stddev",
         "upstreamCount", "brkCount", "meanDeltaBrkMinusUpstream", "pooledStddev", "standardizedDifference",
         "confidence95Low", "confidence95High"],
        model_summary_rows,
    )

    ride2 = model_summaries["Ride2"]
    crash = model_summaries["Crash"]
    summary = {
        "schema": "brk-modal-p47a-noise-ensemble-summary-v1",
        "caseCount": len(cases),
        "seedCount": len({item.seed_decimal for item in cases}),
        "seeds": [
            {"index": item.seed_index, "decimal": item.seed_decimal, "hex": item.seed_hex}
            for item in sorted((case for case in cases if case.model == "Ride2"), key=lambda case: case.seed_index)
        ],
        "models": model_summaries,
        "method": {
            "waveformCorrelationUsedForPassFail": False,
            "rngVariation": "Within-engine distribution and standard deviation across 16 explicit seeds.",
            "modalEnvelopeDifference": "Difference between upstream and BRK ensemble means, reported with pooled standardized difference and approximate 95% interval.",
            "randomGenerators": {
                "upstream": "real pinned RipplerX AudioProcessor, std::srand(seed) + std::rand()",
                "brk": "Engine::prepare(namespaced seed) + existing per-voice derivation + xorshift32",
                "sequenceIdentityExpected": False,
            },
            "powerSpectrum": {"estimator": "Hann-window Welch mean power", "fftSize": FFT_SIZE, "hopSize": HOP_SIZE},
            "rmsEnvelopeWindowSeconds": RMS_WINDOW_SECONDS,
            "spectralDensityDefinition": "fraction of 20 Hz-20 kHz FFT bins within 40 dB of each take's spectral peak",
        },
        "ride2AdditionalOvertones": {
            "statisticalQuestion": "Which normalized frequency bands retain a positive BRK-minus-upstream ensemble delta after within-engine seed spread is included?",
            "notablePositiveBands": ride2["spectrum"]["notablePositiveBands"],
            "notableNegativeBands": ride2["spectrum"]["notableNegativeBands"],
            "interpretationRule": "A band is listed only when the approximate 95% interval for the ensemble-mean delta excludes zero; this is evidence of a persistent spectral balance difference, not an accidental single-take partial.",
        },
        "crashSpectralDensity": {
            "metric": crash["metrics"]["spectral_density"],
            "flatness": crash["metrics"]["spectral_flatness"],
            "interpretation": "Within-engine seed spread is RNG variation; the between-engine ensemble mean delta is the measured modal/envelope density difference.",
        },
        "determinism": {
            "brkMachineReadableRepeat": "validated by byte-identical sorted SHA-256 manifests in CI before upstream comparison",
            "upstreamSeedPolicy": "explicit and reproducible on the recorded libc/platform; std::rand remains implementation-dependent across platforms",
        },
    }
    (args.output_dir / "p47a-noise-ensemble-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8"
    )

    write_listening_artifact(cases, audios, metrics, args.listening_dir)

    ride2_positive = summary["ride2AdditionalOvertones"]["notablePositiveBands"]
    crash_density = summary["crashSpectralDensity"]["metric"]["modalEnvelopeDifference"]
    report_lines = [
        "# BRK Modal P4.7A noise ensemble report",
        "",
        f"- cases: {len(cases)} ({summary['seedCount']} seeds × 2 models × 2 engines);",
        "- primary gate: ensemble spectrum/envelope/energy distributions;",
        "- raw single-take waveform correlation is not used as pass/fail;",
        "- RNG variation: within-engine spread across seeds;",
        "- modal/envelope difference: between-engine ensemble-mean delta relative to that spread.",
        "",
        "## Ride2 additional-overtones result",
        "",
        f"Persistent positive normalized-energy bands: {', '.join(item['band'] for item in ride2_positive) if ride2_positive else 'none at the stated interval rule'}.",
        "These are ensemble spectral-balance differences; a bright overtone in one take is not treated as an accidental extra modal frequency.",
        "",
        "## Crash spectral-density result",
        "",
        f"BRK minus upstream density mean: {crash_density['meanDeltaBrkMinusUpstream']:.9g}; "
        f"pooled standardized difference: "
        f"{crash_density['standardizedDifference'] if crash_density['standardizedDifference'] is not None else 'undefined (zero pooled spread)'}.",
        "This value is separated from the upstream and BRK within-engine RNG standard deviations in model-summary.csv and JSON.",
        "",
        "## Listening artifact",
        "",
        "Use brk-modal-p47a-listening.wav with the cue CSV. Each cue contains the strike/body, then a 1.3-2.3 s tail excerpt. Compare adjacent upstream/BRK cues for the same seed.",
    ]
    (args.output_dir / "REPORT.md").write_text("\n".join(report_lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
