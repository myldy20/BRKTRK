#!/usr/bin/env python3
"""Map lossless RipplerX factory data into provisional BRK Modal state v1.

The raw upstream program bundle remains the source of truth. This migration is
versioned so later ABI/state changes never reinterpret old program data silently.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

PARTIAL_COUNTS = (4, 8, 16, 32, 64, 1, 2)


def number(values: dict[str, float | None], key: str, default: float) -> float:
    value = values.get(key, default)
    return default if value is None else float(value)


def boolean(values: dict[str, float | None], key: str, default: bool) -> bool:
    return bool(round(number(values, key, 1.0 if default else 0.0)))


def choice(values: dict[str, float | None], key: str, default: int, maximum: int) -> int:
    return max(0, min(maximum, int(round(number(values, key, float(default))))))


def migrate_low_cut(raw: float) -> float:
    """Accept current signed -1..1 state and legacy factory values in hertz.

    The current resonator maps positive control p to 20 * 1000**p Hz. Bundled
    factory XML stores the previous actual-Hz values, so invert the DSP mapping
    to preserve the audible cutoff rather than merely preserving a UI skew.
    """
    if -1.0 <= raw <= 1.0:
        return raw
    frequency = max(20.0, min(20000.0, raw))
    return math.log(frequency / 20.0) / math.log(1000.0)


def resonator(values: dict[str, float | None], prefix: str) -> dict[str, object]:
    partial_choice = choice(values, f"{prefix}_partials", 3, len(PARTIAL_COUNTS) - 1)
    return {
        "enabled": boolean(values, f"{prefix}_on", prefix == "a"),
        "model": choice(values, f"{prefix}_model", 0, 11),
        "partials": PARTIAL_COUNTS[partial_choice],
        "decaySeconds": number(values, f"{prefix}_decay", 1.0),
        "material": number(values, f"{prefix}_damp", 0.0),
        "tone": number(values, f"{prefix}_tone", 0.0),
        "hitPosition": number(values, f"{prefix}_hit", 0.26),
        "releaseScale": number(values, f"{prefix}_rel", 1.0),
        "inharmonicity": number(values, f"{prefix}_inharm", 0.0001),
        "ratio": number(values, f"{prefix}_ratio", 1.0),
        "lowCut": migrate_low_cut(number(values, f"{prefix}_cut", 0.0)),
        "coarseSemitones": number(values, f"{prefix}_coarse", 0.0),
        "fineCents": number(values, f"{prefix}_fine", 0.0),
        "tubeRadius": number(values, f"{prefix}_radius", 0.5),
        "spectralFocus": 0.0,
        "upstreamVelocity": {
            "decay": number(values, f"vel_{prefix}_decay", 0.0),
            "hitPosition": number(values, f"vel_{prefix}_hit", 0.0),
            "inharmonicity": number(values, f"vel_{prefix}_inharm", 0.0),
            "material": number(values, f"vel_{prefix}_damp", 0.0),
            "tone": number(values, f"vel_{prefix}_tone", 0.0),
        },
    }


def migrate_program(program: dict[str, object]) -> dict[str, object]:
    values = program["parameters"]
    assert isinstance(values, dict)
    return {
        "index": program["index"],
        "name": program["name"],
        "origin": {
            "engine": "RipplerX",
            "version": "1.5.18",
            "license": "GPL-3.0-only",
            "source": program["source"],
        },
        "state": {
            "schema": "brk-modal-state-v1-provisional",
            "resonatorA": resonator(values, "a"),
            "resonatorB": resonator(values, "b"),
            "exciter": {
                "malletDirect": number(values, "mallet_mix", 0.0),
                "malletResonator": number(values, "mallet_res", 0.8),
                "malletHardnessHz": number(values, "mallet_stiff", 600.0),
                "malletKeytrack": number(values, "mallet_ktrack", 0.0),
                "malletVelocityDirect": number(values, "vel_mallet_mix", 0.0),
                "malletVelocityResonator": number(values, "vel_mallet_res", 0.0),
                "malletVelocityHardness": number(values, "vel_mallet_stiff", 0.0),
                "useUpstreamNoise": True,
                "noiseDirect": number(values, "noise_mix", 0.0),
                "noiseResonator": number(values, "noise_res", 0.0),
                "noiseDecayMs": number(values, "noise_dec", 500.0),
                "noiseColor": 0.5,
                "noiseFilterMode": choice(values, "noise_filter_mode", 2, 2),
                "noiseFilterFrequencyHz": number(values, "noise_filter_freq", 20.0),
                "noiseFilterQ": number(values, "noise_filter_q", 0.707),
                "noiseAttackMs": number(values, "noise_att", 1.0),
                "noiseSustain": number(values, "noise_sus", 0.0),
                "noiseReleaseMs": number(values, "noise_rel", 500.0),
                "noiseAttackTension": number(values, "noise_att_ten", 0.4),
                "noiseDecayTension": number(values, "noise_dec_ten", 0.4),
                "noiseReleaseTension": number(values, "noise_rel_ten", 0.4),
                "noiseVelocityDirect": number(values, "vel_noise_mix", 0.0),
                "noiseVelocityResonator": number(values, "vel_noise_res", 0.0),
                "noiseVelocityFrequency": number(values, "vel_noise_freq", 0.0),
                "noiseVelocityQ": number(values, "vel_noise_q", 0.0),
                "noiseVelocityAttack": number(values, "vel_noise_att", 0.0),
                "noiseVelocityDecay": number(values, "vel_noise_dec", 0.0),
                "noiseVelocitySustain": number(values, "vel_noise_sus", 0.0),
                "noiseVelocityRelease": number(values, "vel_noise_rel", 0.0),
            },
            "downstreamVelocityMacro": {
                "response": 0.0,
                "curve": 1.0,
                "malletHardnessOctaves": 0.0,
                "noiseColor": 0.0,
                "decayOctaves": 0.0,
                "material": 0.0,
                "tone": 0.0,
                "inharmonicity": 0.0,
            },
            "coupling": "serial" if boolean(values, "couple", False) else "parallel",
            "couplingProfile": "reference",
            "parallelMix": number(values, "ab_mix", 0.5),
            "couplingSplit": number(values, "ab_split", 0.01),
            "maxCouplingDetuneCents": 0.0,
            "releaseMode": "damped",
            "retriggerDeclickMs": 2.5,
            "resonatorGainDb": number(values, "gain", 0.0),
            "outputGainDb": -2.5,
            "stereoMode": "comb",
            "stereoWidth": 1.0,
            "polyphony": 8,
        },
        "unmappedSourceOnlyParameters": [
            "mallet_type", "mallet_pitch", "mallet_filter", "noise_osc",
            "bend_range", "reuse_voices", "fadeout_repeats",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--programs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        source = json.loads(args.programs.read_text(encoding="utf-8"))
        migrated = [migrate_program(program) for program in source["programs"]]
        result = {
            "schema": "brk-modal-migrated-program-bank-v1",
            "schemaVersion": 1,
            "sourceSchema": source["schema"],
            "upstream": source["upstream"],
            "programs": migrated,
            "notes": [
                "Factory-required RipplerX 1.5.18 parameters map into provisional BRK state v1.",
                "Legacy factory low-cut frequencies migrate through the inverse current DSP mapping.",
                "Reference profile preserves upstream all-pairs splitting, modal gain, impulse scale and output limiting.",
                "A calibrated -2.5 dB Reference-bank trim replaces per-preset normalization.",
                "BRK downstream macro velocity is neutralized for imported programs.",
                "Source-only mallet samples, oscillator excitation and host behavior remain explicit follow-up extensions.",
            ],
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"migrate_ripplerx_programs: {exc}", file=sys.stderr)
        return 1
    print(f"migrated {len(migrated)} programs to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
