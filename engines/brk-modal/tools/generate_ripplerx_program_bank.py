#!/usr/bin/env python3
"""Generate a compact C++ factory bank from lossless RipplerX program JSON."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

KEYS = (
    "a_model", "a_on", "a_partials", "a_decay", "a_damp", "a_tone", "a_hit", "a_rel", "a_inharm", "a_ratio", "a_cut", "a_radius", "a_coarse", "a_fine",
    "b_model", "b_on", "b_partials", "b_decay", "b_damp", "b_tone", "b_hit", "b_rel", "b_inharm", "b_ratio", "b_cut", "b_radius", "b_coarse", "b_fine",
    "mallet_mix", "mallet_res", "mallet_stiff", "vel_mallet_mix", "vel_mallet_res", "vel_mallet_stiff",
    "noise_mix", "noise_res", "noise_filter_mode", "noise_filter_freq", "noise_filter_q", "noise_att", "noise_dec", "noise_sus", "noise_rel", "vel_noise_mix", "vel_noise_res",
    "vel_a_decay", "vel_a_hit", "vel_a_inharm", "vel_b_decay", "vel_b_hit", "vel_b_inharm", "couple", "ab_mix", "ab_split", "gain",
)


def migrate_low_cut(raw: float) -> float:
    if -1.0 <= raw <= 1.0:
        return raw
    frequency = max(20.0, min(20000.0, raw))
    return math.log(frequency / 20.0) / math.log(1000.0)


def cpp_float(key: str, value: float | None) -> str:
    if value is None:
        value = 0.0
    if key in ("a_cut", "b_cut"):
        value = migrate_low_cut(float(value))
    text = f"{float(value):.7g}"
    if "e" not in text and "." not in text:
        text += "."
    return text + "F"


def generate(source: dict[str, object]) -> str:
    programs = source["programs"]
    quoted_names = ", ".join(json.dumps(str(program["name"])) for program in programs)
    lines = [
        "// Generated from GPL-3.0 RipplerX 1.5.18 factory XML.",
        "// Legacy low-cut frequencies are migrated through the inverse current DSP mapping.",
        "namespace {",
        f"constexpr std::size_t kProgramFieldCount = {len(KEYS)};",
        "constexpr std::array<const char*, kRipplerXProgramCount> kRipplerXProgramNames = {",
        f"    {quoted_names},",
        "};",
        "constexpr std::array<std::array<float, kProgramFieldCount>, kRipplerXProgramCount> kRipplerXProgramValues = {{",
    ]
    for program in programs:
        parameters = program["parameters"]
        row = ", ".join(cpp_float(key, parameters.get(key)) for key in KEYS)
        lines.append(f"    {{{{{row}}}}}, // {program['name']}")
    lines += [
        "}};",
        "constexpr std::array<std::uint8_t, 7> kPartialCounts = {4, 8, 16, 32, 64, 1, 2};",
        "} // namespace",
        "",
        "Patch make_ripplerx_program(RipplerXProgram program) noexcept {",
        "    const auto index = std::min<std::size_t>(static_cast<std::size_t>(program), kRipplerXProgramCount - 1U);",
        "    const auto& v = kRipplerXProgramValues[index];",
        "    Patch p{};",
        "    const auto partials = [](float value) noexcept {",
        "        const auto i = std::clamp<int>(static_cast<int>(std::lround(value)), 0, 6);",
        "        return kPartialCounts[static_cast<std::size_t>(i)];",
        "    };",
    ]
    for index, key in enumerate(KEYS):
        lines.append(f"    constexpr std::size_t i_{key} = {index};")
    lines += [
        "    p.resonator_a.model = static_cast<Model>(std::clamp<int>(static_cast<int>(std::lround(v[i_a_model])), 0, 11));",
        "    p.resonator_a.enabled = v[i_a_on] >= 0.5F;",
        "    p.resonator_a.partials = partials(v[i_a_partials]);",
        "    p.resonator_a.decay_seconds = v[i_a_decay];",
        "    p.resonator_a.material = v[i_a_damp];",
        "    p.resonator_a.tone = v[i_a_tone];",
        "    p.resonator_a.hit_position = v[i_a_hit];",
        "    p.resonator_a.release_scale = v[i_a_rel];",
        "    p.resonator_a.inharmonicity = v[i_a_inharm];",
        "    p.resonator_a.ratio = v[i_a_ratio];",
        "    p.resonator_a.low_cut = v[i_a_cut];",
        "    p.resonator_a.tube_radius = v[i_a_radius];",
        "    p.resonator_a.coarse_semitones = v[i_a_coarse];",
        "    p.resonator_a.fine_cents = v[i_a_fine];",
        "    p.resonator_a.spectral_focus = 0.0F;",
        "    p.resonator_a.normalize_modal_energy = false;",
        "    p.resonator_a.upstream_velocity.decay = v[i_vel_a_decay];",
        "    p.resonator_a.upstream_velocity.hit_position = v[i_vel_a_hit];",
        "    p.resonator_a.upstream_velocity.inharmonicity = v[i_vel_a_inharm];",
        "    p.resonator_b.model = static_cast<Model>(std::clamp<int>(static_cast<int>(std::lround(v[i_b_model])), 0, 11));",
        "    p.resonator_b.enabled = v[i_b_on] >= 0.5F;",
        "    p.resonator_b.partials = partials(v[i_b_partials]);",
        "    p.resonator_b.decay_seconds = v[i_b_decay];",
        "    p.resonator_b.material = v[i_b_damp];",
        "    p.resonator_b.tone = v[i_b_tone];",
        "    p.resonator_b.hit_position = v[i_b_hit];",
        "    p.resonator_b.release_scale = v[i_b_rel];",
        "    p.resonator_b.inharmonicity = v[i_b_inharm];",
        "    p.resonator_b.ratio = v[i_b_ratio];",
        "    p.resonator_b.low_cut = v[i_b_cut];",
        "    p.resonator_b.tube_radius = v[i_b_radius];",
        "    p.resonator_b.coarse_semitones = v[i_b_coarse];",
        "    p.resonator_b.fine_cents = v[i_b_fine];",
        "    p.resonator_b.spectral_focus = 0.0F;",
        "    p.resonator_b.normalize_modal_energy = false;",
        "    p.resonator_b.upstream_velocity.decay = v[i_vel_b_decay];",
        "    p.resonator_b.upstream_velocity.hit_position = v[i_vel_b_hit];",
        "    p.resonator_b.upstream_velocity.inharmonicity = v[i_vel_b_inharm];",
        "    p.exciter.mallet_direct = v[i_mallet_mix];",
        "    p.exciter.mallet_resonator = v[i_mallet_res];",
        "    p.exciter.mallet_hardness_hz = v[i_mallet_stiff];",
        "    p.exciter.mallet_velocity_direct = v[i_vel_mallet_mix];",
        "    p.exciter.mallet_velocity_resonator = v[i_vel_mallet_res];",
        "    p.exciter.mallet_velocity_hardness = v[i_vel_mallet_stiff];",
        "    p.exciter.use_upstream_noise = true;",
        "    p.exciter.noise_direct = v[i_noise_mix];",
        "    p.exciter.noise_resonator = v[i_noise_res];",
        "    p.exciter.noise_filter_mode = static_cast<NoiseFilterMode>(std::clamp<int>(static_cast<int>(std::lround(v[i_noise_filter_mode])), 0, 2));",
        "    p.exciter.noise_filter_frequency_hz = v[i_noise_filter_freq];",
        "    p.exciter.noise_filter_q = v[i_noise_filter_q];",
        "    p.exciter.noise_attack_ms = v[i_noise_att];",
        "    p.exciter.noise_decay_ms = v[i_noise_dec];",
        "    p.exciter.noise_sustain = v[i_noise_sus];",
        "    p.exciter.noise_release_ms = v[i_noise_rel];",
        "    p.exciter.noise_velocity_direct = v[i_vel_noise_mix];",
        "    p.exciter.noise_velocity_resonator = v[i_vel_noise_res];",
        "    p.velocity.response = 0.0F;",
        "    p.velocity.curve = 1.0F;",
        "    p.velocity.mallet_hardness_octaves = 0.0F;",
        "    p.velocity.noise_color = 0.0F;",
        "    p.velocity.decay_octaves = 0.0F;",
        "    p.velocity.material = 0.0F;",
        "    p.velocity.tone = 0.0F;",
        "    p.velocity.inharmonicity = 0.0F;",
        "    p.coupling = v[i_couple] >= 0.5F ? Coupling::Serial : Coupling::Parallel;",
        "    p.coupling_profile = CouplingProfile::Reference;",
        "    p.parallel_mix = v[i_ab_mix];",
        "    p.coupling_split = v[i_ab_split];",
        "    p.max_coupling_detune_cents = 0.0F;",
        "    p.release_mode = ReleaseMode::Damped;",
        "    p.resonator_gain_db = v[i_gain];",
        "    p.output_gain_db = -2.5F;",
        "    p.stereo_mode = StereoMode::Comb;",
        "    p.stereo_width = 1.0F;",
        "    p.polyphony = 8;",
        "    return p;",
        "}",
        "",
        "const char* ripplerx_program_name(RipplerXProgram program) noexcept {",
        "    const auto index = std::min<std::size_t>(static_cast<std::size_t>(program), kRipplerXProgramCount - 1U);",
        "    return kRipplerXProgramNames[index];",
        "}",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--programs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        source = json.loads(args.programs.read_text(encoding="utf-8"))
        if len(source["programs"]) != 28:
            raise ValueError("expected 28 programs")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(generate(source), encoding="utf-8")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"generate_ripplerx_program_bank: {exc}", file=sys.stderr)
        return 1
    print(f"generated {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
