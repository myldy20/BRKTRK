#include "brk_modal/brk_modal.hpp"

#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>

namespace {
constexpr std::uint32_t kRate = 48000U;
constexpr std::uint32_t kBlock = 128U;
constexpr std::uint32_t kRampFrames = 576U;

bool same_bits(float left, float right) noexcept {
    return std::memcmp(&left, &right, sizeof(float)) == 0;
}

brk::modal::Patch make_crystal_stress_patch() {
    brk::modal::Patch patch{};
    patch.coupling_profile = brk::modal::CouplingProfile::Reference;
    patch.coupling = brk::modal::Coupling::Serial;
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    patch.stereo_width = 1.0F;
    patch.polyphony = 8;
    patch.resonator_a.enabled = true;
    patch.resonator_a.model = brk::modal::Model::Squared;
    patch.resonator_a.partials = 32;
    patch.resonator_a.decay_seconds = 4.5F;
    patch.resonator_a.material = -0.47F;
    patch.resonator_a.tone = 0.0F;
    patch.resonator_a.hit_position = 0.26F;
    patch.resonator_a.inharmonicity = 0.0001F;
    patch.resonator_a.ratio = 0.78F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = brk::modal::Model::Marimba;
    patch.resonator_b.partials = 32;
    patch.resonator_b.decay_seconds = 16.2F;
    patch.resonator_b.material = -0.57F;
    patch.resonator_b.tone = 0.0F;
    patch.resonator_b.hit_position = 0.26F;
    patch.resonator_b.inharmonicity = 0.0001F;
    patch.resonator_b.ratio = 0.78F;
    patch.exciter.use_upstream_noise = true;
    patch.exciter.mallet_direct = 0.0F;
    patch.exciter.mallet_resonator = 0.0F;
    patch.exciter.noise_direct = 0.0F;
    patch.exciter.noise_resonator = 0.23F;
    patch.exciter.noise_filter_mode = brk::modal::NoiseFilterMode::BandPass;
    patch.exciter.noise_filter_frequency_hz = 2784.0F;
    patch.exciter.noise_filter_q = 3.047F;
    patch.exciter.noise_attack_ms = 1.0F;
    patch.exciter.noise_decay_ms = 23.0F;
    patch.exciter.noise_sustain = 0.0F;
    patch.exciter.noise_release_ms = 407.0F;
    patch.resonator_gain_db = -6.0F;
    patch.output_gain_db = -3.0F;
    return patch;
}

bool compare_block(brk::modal::Engine& oracle, brk::modal::Engine& fast) {
    std::array<float, kBlock> ol{};
    std::array<float, kBlock> oright{};
    std::array<float, kBlock> fl{};
    std::array<float, kBlock> fright{};
    oracle.process(ol.data(), oright.data(), kBlock);
    fast.process(fl.data(), fright.data(), kBlock);
    for (std::size_t i = 0; i < kBlock; ++i) {
        if (!same_bits(ol[i], fl[i]) || !same_bits(oright[i], fright[i])) return false;
    }
    return true;
}

bool run_exact_oracle() {
    brk::modal::Engine oracle;
    brk::modal::Engine fast;
    if (!oracle.prepare(kRate, kBlock, 0x4c495645U)
        || !fast.prepare(kRate, kBlock, 0x4c495645U)) return false;

    auto patch = make_crystal_stress_patch();
    oracle.set_patch(patch);
    fast.set_patch(patch);
    constexpr std::array<std::int16_t, 8> keys{84, 86, 88, 89, 91, 93, 95, 96};
    for (std::size_t i = 0; i < keys.size(); ++i) {
        const brk::modal::NoteOn note{
            static_cast<std::uint32_t>(i + 1U), keys[i], 1.0F, 0.0F};
        oracle.note_on(note);
        fast.note_on(note);
    }
    for (int block = 0; block < 12; ++block) {
        if (!compare_block(oracle, fast)) {
            std::cerr << "pre-roll mismatch block=" << block << '\n';
            return false;
        }
    }

    float oracle_left = 0.0F;
    float oracle_right = 0.0F;
    float fast_left = 0.0F;
    float fast_right = 0.0F;
    for (std::uint32_t frame = 0; frame < kRampFrames; ++frame) {
        const float t = static_cast<float>(frame)
            / static_cast<float>(kRampFrames - 1U);
        patch.resonator_a.decay_seconds = 4.5F + (2.25F - 4.5F) * t;
        patch.resonator_a.material = -0.47F + (0.15F + 0.47F) * t;
        patch.resonator_a.tone = 0.0F + 0.35F * t;
        patch.stereo_width = 1.0F + (0.5F - 1.0F) * t;

        oracle.set_patch(patch);
        fast.set_live_performance_patch(
            patch,
            true, true, true,
            false, false, false,
            true);
        oracle.process(&oracle_left, &oracle_right, 1U);
        fast.process(&fast_left, &fast_right, 1U);
        if (!same_bits(oracle_left, fast_left)
            || !same_bits(oracle_right, fast_right)) {
            std::cerr << "live-control mismatch frame=" << frame
                      << " oracle=" << oracle_left << ',' << oracle_right
                      << " fast=" << fast_left << ',' << fast_right << '\n';
            return false;
        }
    }

    for (int block = 0; block < 16; ++block) {
        if (!compare_block(oracle, fast)) {
            std::cerr << "post-ramp mismatch block=" << block << '\n';
            return false;
        }
    }

    // Exercise the dedicated Tone-only path against generic set_patch(), frame
    // by frame, so the optimization may not change a single output bit.
    for (std::uint32_t frame = 0; frame < kRampFrames; ++frame) {
        const float t = static_cast<float>(frame)
            / static_cast<float>(kRampFrames - 1U);
        patch.resonator_a.tone = 0.35F + (-0.60F * t);
        oracle.set_patch(patch);
        fast.set_live_performance_patch(
            patch,
            false, false, true,
            false, false, false,
            false);
        oracle.process(&oracle_left, &oracle_right, 1U);
        fast.process(&fast_left, &fast_right, 1U);
        if (!same_bits(oracle_left, fast_left)
            || !same_bits(oracle_right, fast_right)) {
            std::cerr << "tone-only mismatch frame=" << frame
                      << " oracle=" << oracle_left << ',' << oracle_right
                      << " fast=" << fast_left << ',' << fast_right << '\n';
            return false;
        }
    }

    std::cout << "p9e_live_control_exact_oracle=bit-identical\n";
    std::cout << "p9e_tone_only_exact_oracle=bit-identical\n";
    return true;
}
} // namespace

int main() {
    return run_exact_oracle() ? 0 : 1;
}
