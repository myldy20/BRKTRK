#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <vector>

using namespace brk::modal;

namespace {

Patch make_patch() {
    Patch patch{};
    patch.coupling_profile = CouplingProfile::Reference;
    patch.coupling = Coupling::Serial;
    patch.stereo_mode = StereoMode::Comb;
    patch.stereo_width = 1.0F;
    patch.polyphony = 8;

    patch.resonator_a.enabled = true;
    patch.resonator_a.model = Model::Squared;
    patch.resonator_a.partials = 32;
    patch.resonator_a.max_render_partials = 32;
    patch.resonator_a.decay_seconds = 4.5F;

    patch.resonator_b.enabled = true;
    patch.resonator_b.model = Model::Marimba;
    patch.resonator_b.partials = 32;
    patch.resonator_b.max_render_partials = 32;
    patch.resonator_b.decay_seconds = 16.2F;

    patch.exciter.mallet_resonator = 0.82F;
    patch.exciter.noise_resonator = 0.12F;
    patch.exciter.noise_decay_ms = 407.0F;
    patch.output_gain_db = -6.0F;
    return patch;
}

double run(bool fast) {
    Engine engine;
    if (!engine.prepare(48000.0, 128, 0x0DEC0A11ULL)) return 1.0e30;
    engine.set_modal_kernel(ModalKernel::Auto);

    Patch patch = make_patch();
    engine.set_patch(patch);
    for (std::uint32_t i = 0; i < 8; ++i) {
        engine.note_on({
            100U + i,
            static_cast<std::int16_t>(48 + i),
            0.75F,
            0.0F,
        });
    }

    std::array<float, 128> left{};
    std::array<float, 128> right{};
    for (int i = 0; i < 8; ++i) {
        engine.process(left.data(), right.data(), 128);
    }

    float sink = 0.0F;
    constexpr std::uint32_t ramp = 576U;
    constexpr std::uint32_t frames = ramp * 12U;
    const auto start = std::chrono::steady_clock::now();

    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const float phase =
            static_cast<float>(frame % ramp) / static_cast<float>(ramp - 1U);
        patch.resonator_a.decay_seconds = (frame / ramp) % 2U == 0U
            ? 4.5F + (0.65F - 4.5F) * phase
            : 0.65F + (4.5F - 0.65F) * phase;

        if (fast) engine.set_live_decay_patch(patch, true, false);
        else engine.set_patch(patch);

        float l = 0.0F;
        float r = 0.0F;
        engine.process(&l, &r, 1U);
        sink += l + r;
    }

    const auto stop = std::chrono::steady_clock::now();
    if (sink == 1234567.0F) std::cerr << sink;
    return std::chrono::duration<double, std::milli>(stop - start).count();
}

double median(bool fast) {
    std::vector<double> values;
    for (int i = 0; i < 5; ++i) values.push_back(run(fast));
    std::sort(values.begin(), values.end());
    return values[values.size() / 2U];
}

} // namespace

int main() {
    const double generic_ms = median(false);
    const double fast_ms = median(true);
    std::cout << "p9e_decay_generic_ms=" << generic_ms << '\n';
    std::cout << "p9e_decay_fast_ms=" << fast_ms << '\n';
    std::cout << "p9e_decay_ratio=" << (fast_ms / generic_ms) << '\n';
    return 0;
}
