#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>

namespace {

std::vector<float> render_patch(brk::modal::Patch patch, std::int16_t key, bool release_note) {
    constexpr std::uint32_t sample_rate = 48000;
    constexpr std::uint32_t block = 128;
    constexpr std::uint32_t frames = sample_rate;
    brk::modal::Engine engine;
    if (!engine.prepare(sample_rate, block, 0x52585031353138ULL)) return {};
    engine.set_patch(patch);
    engine.note_on({1U, key, 0.8F, 0.0F});

    std::vector<float> result(frames);
    std::array<float, block> left{};
    std::array<float, block> right{};
    for (std::uint32_t offset = 0; offset < frames; offset += block) {
        if (release_note && offset == sample_rate / 4U) engine.note_off(1U);
        const auto count = std::min(block, frames - offset);
        engine.process(left.data(), right.data(), count);
        for (std::uint32_t i = 0; i < count; ++i) result[offset + i] = 0.5F * (left[i] + right[i]);
    }
    return result;
}

std::vector<float> render_model(brk::modal::Model model, std::int16_t key) {
    brk::modal::Patch patch{};
    patch.resonator_a.model = model;
    patch.resonator_a.partials = 64;
    patch.resonator_a.decay_seconds = 1.5F;
    patch.resonator_a.spectral_focus = 0.15F;
    patch.resonator_b.enabled = false;
    patch.release_mode = brk::modal::ReleaseMode::OneShot;
    patch.output_gain_db = -10.0F;
    return render_patch(patch, key, false);
}

std::uint64_t hash_audio(const std::vector<float>& audio) {
    std::uint64_t hash = 1469598103934665603ULL;
    for (float sample : audio) {
        const auto value = static_cast<std::int32_t>(std::lrint(sample * 1000000.0F));
        hash ^= static_cast<std::uint32_t>(value);
        hash *= 1099511628211ULL;
    }
    return hash;
}

bool valid(const std::vector<float>& audio) {
    if (audio.empty()) return false;
    bool audible = false;
    for (float sample : audio) {
        if (!std::isfinite(sample) || std::abs(sample) > 1.0F) return false;
        audible = audible || std::abs(sample) > 1.0e-6F;
    }
    return audible;
}

brk::modal::Patch upstream_noise_patch(brk::modal::NoiseFilterMode filter, float cutoff, float low_cut) {
    brk::modal::Patch patch{};
    patch.resonator_a.model = brk::modal::Model::Plate;
    patch.resonator_a.partials = 32;
    patch.resonator_a.decay_seconds = 1.0F;
    patch.resonator_a.low_cut = low_cut;
    patch.resonator_a.spectral_focus = 0.0F;
    patch.resonator_b.enabled = false;
    patch.exciter.mallet_resonator = 0.0F;
    patch.exciter.use_upstream_noise = true;
    patch.exciter.noise_direct = 0.15F;
    patch.exciter.noise_resonator = 0.55F;
    patch.exciter.noise_filter_mode = filter;
    patch.exciter.noise_filter_frequency_hz = cutoff;
    patch.exciter.noise_filter_q = 1.2F;
    patch.exciter.noise_attack_ms = 5.0F;
    patch.exciter.noise_decay_ms = 180.0F;
    patch.exciter.noise_sustain = 0.25F;
    patch.exciter.noise_release_ms = 120.0F;
    patch.exciter.noise_attack_tension = 0.4F;
    patch.exciter.noise_decay_tension = 0.4F;
    patch.exciter.noise_release_tension = 0.4F;
    patch.velocity.response = 0.0F;
    patch.velocity.mallet_hardness_octaves = 0.0F;
    patch.velocity.decay_octaves = 0.0F;
    patch.velocity.material = 0.0F;
    patch.velocity.tone = 0.0F;
    patch.velocity.inharmonicity = 0.0F;
    patch.output_gain_db = -12.0F;
    return patch;
}

} // namespace

int main() {
    if (std::strcmp(brk::modal::kRipplerXUpstreamVersion, "1.5.18") != 0) return 1;
    const auto marimba2 = render_model(brk::modal::Model::Marimba2, 52);
    const auto bell = render_model(brk::modal::Model::Bell, 52);
    const auto djembe_low = render_model(brk::modal::Model::Djembe, 40);
    const auto djembe_high = render_model(brk::modal::Model::Djembe, 64);
    if (!valid(marimba2) || !valid(bell) || !valid(djembe_low) || !valid(djembe_high)) return 2;
    if (hash_audio(marimba2) == hash_audio(bell)) return 3;
    if (hash_audio(bell) == hash_audio(djembe_low)) return 4;
    if (hash_audio(djembe_low) == hash_audio(djembe_high)) return 5;

    const auto lowpass = render_patch(upstream_noise_patch(brk::modal::NoiseFilterMode::LowPass, 900.0F, 0.0F), 48, true);
    const auto highpass = render_patch(upstream_noise_patch(brk::modal::NoiseFilterMode::HighPass, 4500.0F, 0.0F), 48, true);
    const auto resonator_lowpass = render_patch(upstream_noise_patch(brk::modal::NoiseFilterMode::BandPass, 1800.0F, -0.65F), 48, true);
    const auto resonator_highpass = render_patch(upstream_noise_patch(brk::modal::NoiseFilterMode::BandPass, 1800.0F, 0.65F), 48, true);
    if (!valid(lowpass) || !valid(highpass) || !valid(resonator_lowpass) || !valid(resonator_highpass)) return 6;
    if (hash_audio(lowpass) == hash_audio(highpass)) return 7;
    if (hash_audio(resonator_lowpass) == hash_audio(resonator_highpass)) return 8;

    std::cout << "marimba2_hash=" << hash_audio(marimba2) << '\n';
    std::cout << "bell_hash=" << hash_audio(bell) << '\n';
    std::cout << "djembe_low_hash=" << hash_audio(djembe_low) << '\n';
    std::cout << "djembe_high_hash=" << hash_audio(djembe_high) << '\n';
    std::cout << "noise_lp_hash=" << hash_audio(lowpass) << '\n';
    std::cout << "noise_hp_hash=" << hash_audio(highpass) << '\n';
    std::cout << "res_lp_hash=" << hash_audio(resonator_lowpass) << '\n';
    std::cout << "res_hp_hash=" << hash_audio(resonator_highpass) << '\n';
    return 0;
}
