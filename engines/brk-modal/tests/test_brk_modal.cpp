#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <numeric>
#include <string_view>
#include <vector>

namespace {
constexpr std::uint32_t kRate = 48000;
constexpr std::uint32_t kBlock = 128;

bool require(bool condition, std::string_view message) {
    if (!condition) std::cerr << "FAIL: " << message << '\n';
    return condition;
}

std::uint64_t hash_audio(const std::vector<float>& samples) {
    std::uint64_t hash = 1469598103934665603ULL;
    for (float sample : samples) {
        const auto q = static_cast<std::int32_t>(std::lrint(sample * 1000000.0F));
        hash ^= static_cast<std::uint32_t>(q);
        hash *= 1099511628211ULL;
    }
    return hash;
}

float rms(const std::vector<float>& samples) {
    if (samples.empty()) return 0.0F;
    const double sum = std::inner_product(samples.begin(), samples.end(), samples.begin(), 0.0);
    return static_cast<float>(std::sqrt(sum / static_cast<double>(samples.size())));
}

float energy(const std::vector<float>& samples, std::size_t begin, std::size_t end) {
    float sum = 0.0F;
    for (std::size_t i = begin; i < end; ++i) sum += samples[i] * samples[i];
    return sum;
}

float max_delta_near(const std::vector<float>& samples, std::size_t center, std::size_t radius) {
    const auto begin = center > radius ? center - radius : 1U;
    const auto end = std::min(samples.size(), center + radius);
    float result = 0.0F;
    for (std::size_t i = begin; i < end; ++i) result = std::max(result, std::abs(samples[i] - samples[i - 1U]));
    return result;
}

std::vector<float> render_coupling(brk::modal::CouplingProfile profile, float focus, std::uint64_t seed) {
    constexpr std::uint32_t frames = kRate * 2U;
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, seed)) return {};
    auto patch = engine.patch();
    patch.resonator_a.model = brk::modal::Model::Plate;
    patch.resonator_a.partials = 64;
    patch.resonator_a.decay_seconds = 2.2F;
    patch.resonator_a.spectral_focus = focus;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = brk::modal::Model::Membrane;
    patch.resonator_b.partials = 64;
    patch.resonator_b.decay_seconds = 1.5F;
    patch.resonator_b.spectral_focus = focus;
    patch.coupling = brk::modal::Coupling::Serial;
    patch.coupling_profile = profile;
    patch.coupling_split = 0.08F;
    patch.max_coupling_detune_cents = 28.0F;
    patch.exciter.noise_resonator = 0.06F;
    patch.exciter.noise_decay_ms = 30.0F;
    patch.output_gain_db = -9.0F;
    engine.set_patch(patch);
    engine.note_on({1U, 52, 0.85F, 0.0F});

    std::vector<float> mono(frames);
    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};
    for (std::uint32_t offset = 0; offset < frames; offset += kBlock) {
        if (offset == kRate / 2U) engine.note_off(1U);
        const auto count = std::min(kBlock, frames - offset);
        engine.process(left.data(), right.data(), count);
        for (std::uint32_t i = 0; i < count; ++i) mono[offset + i] = 0.5F * (left[i] + right[i]);
    }
    return mono;
}

std::vector<float> render_note(brk::modal::Patch patch, float velocity, std::uint64_t seed) {
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, seed)) return {};
    patch.stereo_mode = brk::modal::StereoMode::Mono;
    engine.set_patch(patch);
    engine.note_on({1U, 60, velocity, 0.0F});

    std::vector<float> result(kRate);
    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};
    for (std::uint32_t offset = 0; offset < kRate; offset += kBlock) {
        const auto count = std::min(kBlock, kRate - offset);
        engine.process(left.data(), right.data(), count);
        std::copy_n(left.data(), count, result.data() + offset);
    }
    return result;
}

bool test_stereo() {
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, 7U)) return false;
    auto patch = engine.patch();
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    patch.stereo_width = 1.0F;
    patch.output_gain_db = -12.0F;
    engine.set_patch(patch);
    engine.note_on({1U, 60, 0.8F, 0.0F});
    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};
    double difference = 0.0;
    for (int block = 0; block < 16; ++block) {
        engine.process(left.data(), right.data(), kBlock);
        for (std::size_t i = 0; i < kBlock; ++i) difference += std::abs(left[i] - right[i]);
    }
    return difference > 0.001;
}

bool test_reference_comb_delay_matches_upstream() {
    constexpr std::uint32_t frames = 1200U;
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, frames, 0x434f4d42U)) return false;
    auto patch = engine.patch();
    patch.coupling_profile = brk::modal::CouplingProfile::Reference;
    patch.resonator_a.enabled = false;
    patch.resonator_b.enabled = false;
    patch.exciter.mallet_direct = 1.0F;
    patch.exciter.mallet_resonator = 0.0F;
    patch.exciter.noise_direct = 0.0F;
    patch.exciter.noise_resonator = 0.0F;
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    patch.stereo_width = 1.0F;
    patch.output_gain_db = -24.0F;
    patch.polyphony = 1;
    engine.set_patch(patch);
    engine.note_on({1U, 60, 1.0F, 0.0F});

    std::array<float, frames> left{};
    std::array<float, frames> right{};
    engine.process(left.data(), right.data(), frames);

    std::size_t first_difference = frames;
    for (std::size_t i = 0; i < frames; ++i) {
        if (std::abs(left[i] - right[i]) > 1.0e-7F) {
            first_difference = i;
            break;
        }
    }
    constexpr std::size_t upstream_first_difference = 959U;
    return first_difference == upstream_first_difference;
}

bool test_reference_voice_steal_uses_local_one_ms_fade() {
    brk::modal::Engine engine;
    constexpr std::uint32_t rate = 48000U;
    constexpr std::uint32_t block = 128U;
    if (!engine.prepare(rate, block, 0x53544541U)) return false;
    auto patch = engine.patch();
    patch.coupling_profile = brk::modal::CouplingProfile::Reference;
    patch.polyphony = 2;
    patch.release_mode = brk::modal::ReleaseMode::Natural;
    patch.resonator_a.enabled = true;
    patch.resonator_a.decay_seconds = 8.0F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.decay_seconds = 12.0F;
    patch.coupling = brk::modal::Coupling::Serial;
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    engine.set_patch(patch);

    std::array<float, block> left{};
    std::array<float, block> right{};
    engine.note_on({1U, 84, 1.0F, 0.0F});
    engine.process(left.data(), right.data(), block);
    engine.note_on({2U, 91, 1.0F, 0.0F});
    engine.process(left.data(), right.data(), block);
    engine.note_off(1U);
    engine.process(left.data(), right.data(), 8U);

    engine.note_on({3U, 96, 1.0F, 0.0F});
    if (engine.voice_steal_count() != 1U) return false;
    if (engine.pending_voice_steal_count() != 1U) return false;

    engine.process(left.data(), right.data(), 47U);
    if (engine.pending_voice_steal_count() != 1U) return false;
    engine.process(left.data(), right.data(), 1U);
    if (engine.pending_voice_steal_count() != 0U) return false;
    if (engine.active_voice_count() != 2U) return false;
    for (std::size_t i = 0; i < block; ++i) {
        if (!std::isfinite(left[i]) || !std::isfinite(right[i])) return false;
    }

    // Pinned all-held saturation does not pre-release/damp the oldest pressed
    // voice. Both held voices remain held during the 1 ms pending recycle fade.
    brk::modal::Engine saturated;
    if (!saturated.prepare(rate, block, 0x48454c44U)) return false;
    auto saturated_patch = patch;
    saturated_patch.polyphony = 2;
    saturated_patch.stereo_mode = brk::modal::StereoMode::Mono;
    saturated.set_patch(saturated_patch);
    saturated.note_on({11U, 72, 0.9F, 0.0F});
    saturated.process(left.data(), right.data(), block);
    saturated.note_on({12U, 79, 0.9F, 0.0F});
    saturated.process(left.data(), right.data(), block);
    if (saturated.held_voice_count() != 2U) return false;
    saturated.note_on({13U, 84, 1.0F, 0.0F});
    if (saturated.pending_voice_steal_count() != 1U) return false;
    if (saturated.held_voice_count() != 2U) return false;
    saturated.process(left.data(), right.data(), 47U);
    if (saturated.pending_voice_steal_count() != 1U) return false;
    saturated.process(left.data(), right.data(), 1U);
    if (saturated.pending_voice_steal_count() != 0U) return false;
    if (saturated.held_voice_count() != 2U) return false;

    // Pinned released-victim ordering is release chronology, not residual
    // energy. Voice 22 is released first but is deliberately much hotter than
    // later-released voice 21. Choking 21 after the steal must leave the pending
    // recycle intact, proving 22 was selected.
    brk::modal::Engine ordering;
    if (!ordering.prepare(rate, block, 0x4f524452U)) return false;
    auto ordering_patch = patch;
    ordering_patch.polyphony = 3;
    ordering_patch.stereo_mode = brk::modal::StereoMode::Mono;
    ordering.set_patch(ordering_patch);
    ordering.note_on({21U, 60, 0.02F, 0.0F});
    ordering.process(left.data(), right.data(), block);
    ordering.note_on({22U, 67, 1.0F, 0.0F});
    ordering.process(left.data(), right.data(), block);
    ordering.note_on({23U, 74, 0.7F, 0.0F});
    ordering.process(left.data(), right.data(), block);
    ordering.note_off(22U);
    ordering.process(left.data(), right.data(), 64U);
    ordering.note_off(21U);
    ordering.process(left.data(), right.data(), 64U);
    ordering.note_on({24U, 81, 0.8F, 0.0F});
    if (ordering.pending_voice_steal_count() != 1U) return false;
    ordering.choke(21U);
    if (ordering.pending_voice_steal_count() != 1U) return false;

    std::cout << "reference_voice_recycle_full_lifecycle_parity=ok\n";
    return true;
}

std::vector<float> render_reference_steal_with_global_declick_setting(float declick_ms) {
    brk::modal::Engine engine;
    constexpr std::uint32_t frames = 768U;
    if (!engine.prepare(kRate, kBlock, 0x4445434cU)) return {};
    auto patch = engine.patch();
    patch.coupling_profile = brk::modal::CouplingProfile::Reference;
    patch.polyphony = 1;
    patch.release_mode = brk::modal::ReleaseMode::Natural;
    patch.retrigger_declick_ms = declick_ms;
    patch.stereo_mode = brk::modal::StereoMode::Mono;
    patch.resonator_a.decay_seconds = 8.0F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.decay_seconds = 12.0F;
    patch.coupling = brk::modal::Coupling::Serial;
    patch.output_gain_db = -18.0F;
    engine.set_patch(patch);

    std::vector<float> result(frames);
    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};
    engine.note_on({1U, 60, 0.9F, 0.0F});
    std::uint32_t cursor = 0U;
    for (int block = 0; block < 2; ++block) {
        engine.process(left.data(), right.data(), kBlock);
        std::copy_n(left.data(), kBlock, result.data() + cursor);
        cursor += kBlock;
    }
    engine.note_off(1U);
    engine.process(left.data(), right.data(), 16U);
    std::copy_n(left.data(), 16U, result.data() + cursor);
    cursor += 16U;
    engine.note_on({2U, 96, 1.0F, 0.0F});
    while (cursor < frames) {
        const auto count = std::min<std::uint32_t>(kBlock, frames - cursor);
        engine.process(left.data(), right.data(), count);
        std::copy_n(left.data(), count, result.data() + cursor);
        cursor += count;
    }
    return result;
}

bool test_reference_voice_steal_is_not_global_declick() {
    const auto no_global_fade = render_reference_steal_with_global_declick_setting(0.0F);
    const auto absurd_global_fade = render_reference_steal_with_global_declick_setting(20.0F);
    return !no_global_fade.empty() && no_global_fade == absurd_global_fade;
}

bool test_retrigger_preserves_tail() {
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, 555U)) return false;
    auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate);
    patch.stereo_mode = brk::modal::StereoMode::Mono;
    patch.polyphony = 4;
    engine.set_patch(patch);

    constexpr std::uint32_t frames = kRate * 2U;
    constexpr std::uint32_t retrigger = kRate / 3U;
    constexpr std::uint32_t event_frame = retrigger - (retrigger % kBlock);
    std::vector<float> result(frames);
    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};
    engine.note_on({7U, 60, 0.75F, 0.0F});
    for (std::uint32_t offset = 0; offset < frames; offset += kBlock) {
        if (offset == event_frame) engine.note_on({7U, 60, 0.9F, 0.0F});
        const auto count = std::min(kBlock, frames - offset);
        engine.process(left.data(), right.data(), count);
        std::copy_n(left.data(), count, result.data() + offset);
    }
    return engine.active_voice_count() >= 2U && max_delta_near(result, event_frame, 512U) < 0.65F;
}

bool test_sustain_semantics() {
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, 777U)) return false;
    auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::GlassString);
    patch.release_mode = brk::modal::ReleaseMode::Damped;
    engine.set_patch(patch);
    engine.set_sustain(true);
    engine.note_on({1U, 60, 0.8F, 0.0F});
    engine.note_off(1U);
    const bool held = engine.held_voice_count() == 0U && engine.sustained_voice_count() == 1U && engine.sustain();
    engine.set_sustain(false);
    return held && engine.sustained_voice_count() == 0U && !engine.sustain();
}

bool test_velocity_mapping() {
    auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::DeepMembrane);
    const auto soft = render_note(patch, 0.2F, 900U);
    const auto hard = render_note(patch, 0.95F, 900U);
    if (soft.empty() || hard.empty()) return false;
    const float soft_transient = energy(soft, 0U, 4800U);
    const float hard_transient = energy(hard, 0U, 4800U);
    return hard_transient > soft_transient * 1.35F && hash_audio(soft) != hash_audio(hard);
}

bool test_factory_patches_are_distinct() {
    std::array<std::uint64_t, 6> hashes{};
    for (std::size_t i = 0; i < hashes.size(); ++i) {
        const auto preset = static_cast<brk::modal::FactoryPatch>(i);
        const auto audio = render_note(brk::modal::make_factory_patch(preset), 0.8F, 1200U + i);
        if (audio.empty() || brk::modal::factory_patch_name(preset)[0] == '\0') return false;
        hashes[i] = hash_audio(audio);
    }
    std::sort(hashes.begin(), hashes.end());
    return std::adjacent_find(hashes.begin(), hashes.end()) == hashes.end();
}

bool test_one_shot_release() {
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, 4242U)) return false;
    engine.set_patch(brk::modal::make_factory_patch(brk::modal::FactoryPatch::WoodenBar));
    engine.note_on({3U, 64, 0.8F, 0.0F});
    const bool started = engine.held_voice_count() == 0U && engine.active_voice_count() == 1U;
    engine.note_off(3U);
    return started && engine.active_voice_count() == 1U;
}


bool test_reference_transparent_headroom_is_bounded() {
    brk::modal::Engine engine;
    if (!engine.prepare(kRate, kBlock, 0x50494542U)) return false;
    auto patch = engine.patch();
    patch.coupling_profile = brk::modal::CouplingProfile::Reference;
    patch.stereo_mode = brk::modal::StereoMode::Comb;
    patch.stereo_width = 1.0F;
    patch.polyphony = 8;
    patch.resonator_a.model = brk::modal::Model::Plate;
    patch.resonator_a.partials = 64;
    patch.resonator_a.decay_seconds = 2.4F;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = brk::modal::Model::Beam;
    patch.resonator_b.partials = 64;
    patch.resonator_b.decay_seconds = 1.8F;
    patch.coupling = brk::modal::Coupling::Serial;
    patch.output_gain_db = 24.0F;
    engine.set_patch(patch);
    engine.set_reference_output_mode(brk::modal::ReferenceOutputMode::Normal);

    constexpr std::array<std::int16_t, 8> keys{84, 86, 88, 89, 91, 93, 95, 96};
    for (std::size_t index = 0; index < keys.size(); ++index) {
        engine.note_on({static_cast<std::uint32_t>(index + 1U), keys[index], 1.0F, 0.0F});
    }

    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};
    std::size_t hard_boundary_samples = 0U;
    float maximum = 0.0F;
    for (std::uint32_t block = 0; block < 96U; ++block) {
        engine.process(left.data(), right.data(), kBlock);
        for (std::size_t i = 0; i < kBlock; ++i) {
            for (float sample : {left[i], right[i]}) {
                const float magnitude = std::abs(sample);
                maximum = std::max(maximum, magnitude);
                if (magnitude >= 1.0F) ++hard_boundary_samples;
            }
        }
    }
    std::cout << "reference_headroom_stress_hard_samples=" << hard_boundary_samples << '\n';
    std::cout << "reference_headroom_stress_maximum=" << maximum << '\n';
    return hard_boundary_samples == 0U && maximum > 0.5F && maximum < 1.0F;
}

} // namespace

int main() {
    bool ok = true;
    const auto stable_a = render_coupling(brk::modal::CouplingProfile::Stable, 0.35F, 1234U);
    const auto stable_b = render_coupling(brk::modal::CouplingProfile::Stable, 0.35F, 1234U);
    const auto reference = render_coupling(brk::modal::CouplingProfile::Reference, 0.35F, 1234U);
    const auto wild = render_coupling(brk::modal::CouplingProfile::Wild, 0.0F, 1234U);
    const auto focused = render_coupling(brk::modal::CouplingProfile::Stable, 0.8F, 1234U);

    ok &= require(!stable_a.empty(), "stable render exists");
    ok &= require(stable_a == stable_b, "stable render is deterministic");
    ok &= require(hash_audio(stable_a) != hash_audio(reference), "stable and reference coupling differ");
    ok &= require(hash_audio(reference) != hash_audio(wild), "reference and wild coupling differ");
    ok &= require(hash_audio(stable_a) != hash_audio(focused), "spectral focus changes the sound");
    ok &= require(std::all_of(stable_a.begin(), stable_a.end(), [](float x) {
        return std::isfinite(x) && std::abs(x) <= 1.0F;
    }), "output is finite and bounded");
    ok &= require(rms(stable_a) > 1.0e-5F, "stable coupling is audible");
    ok &= require(rms(reference) > 1.0e-5F, "reference coupling is audible");
    ok &= require(rms(wild) > 1.0e-5F, "wild coupling is audible");
    ok &= require(test_stereo(), "comb stereo produces channel difference");
    ok &= require(test_reference_comb_delay_matches_upstream(), "Reference comb matches pinned RipplerX write-advance-read delay semantics");
    ok &= require(test_reference_voice_steal_uses_local_one_ms_fade(), "Reference voice recycle uses pinned one-ms voice-local fade before restart");
    ok &= require(test_reference_voice_steal_is_not_global_declick(), "Reference voice recycle does not crossfade the whole instrument output");
    ok &= require(test_retrigger_preserves_tail(), "same-note retrigger preserves old tail without a large discontinuity");
    ok &= require(test_sustain_semantics(), "sustain defers release until pedal-up");
    ok &= require(test_velocity_mapping(), "velocity changes level and timbre");
    ok &= require(test_factory_patches_are_distinct(), "six factory patches render distinctly");
    ok &= require(test_one_shot_release(), "one-shot ignores note-off and rings naturally");
    ok &= require(test_reference_transparent_headroom_is_bounded(), "Reference production output uses transparent bounded headroom");

    std::cout << "stable_hash=" << hash_audio(stable_a) << '\n';
    std::cout << "reference_hash=" << hash_audio(reference) << '\n';
    std::cout << "wild_hash=" << hash_audio(wild) << '\n';
    std::cout << "stable_rms=" << rms(stable_a) << '\n';
    if (ok) std::cout << "reference_comb_first_difference_frame=959\n";
    return ok ? 0 : 1;
}
