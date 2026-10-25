#include "brk_modal/brk_modal.hpp"

#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>

using namespace brk::modal;

namespace {

[[noreturn]] void fail(const char* message) {
    std::cerr << "live_decay_oracle_failure=" << message << '\n';
    std::exit(1);
}

void require(bool condition, const char* message) {
    if (!condition) fail(message);
}

std::uint32_t bits(float value) noexcept {
    std::uint32_t result = 0U;
    static_assert(sizeof(result) == sizeof(value));
    std::memcpy(&result, &value, sizeof(value));
    return result;
}

Patch crystal_like(bool serial = true, bool reduced = false) {
    Patch patch{};
    patch.coupling_profile = CouplingProfile::Reference;
    patch.coupling = serial ? Coupling::Serial : Coupling::Parallel;
    patch.stereo_mode = StereoMode::Comb;
    patch.stereo_width = 1.0F;
    patch.polyphony = 8;

    patch.resonator_a.enabled = true;
    patch.resonator_a.model = Model::Squared;
    patch.resonator_a.partials = reduced ? 64 : 32;
    patch.resonator_a.max_render_partials = reduced ? 16 : 32;
    patch.resonator_a.decay_seconds = 4.5F;
    patch.resonator_a.material = -0.2F;

    patch.resonator_b.enabled = true;
    patch.resonator_b.model = Model::Marimba;
    patch.resonator_b.partials = reduced ? 64 : 32;
    patch.resonator_b.max_render_partials = reduced ? 16 : 32;
    patch.resonator_b.decay_seconds = 16.2F;
    patch.resonator_b.material = 0.15F;

    patch.exciter.mallet_resonator = 0.82F;
    patch.exciter.noise_resonator = 0.12F;
    patch.exciter.noise_decay_ms = 407.0F;
    patch.output_gain_db = -6.0F;
    return patch;
}

void require_block_equal(
    const std::array<float, 128>& a,
    const std::array<float, 128>& b) {
    require(std::memcmp(a.data(), b.data(), sizeof(a)) == 0, "block mismatch");
}

void compare_case(
    double sample_rate,
    bool serial,
    bool reduced,
    bool update_a,
    bool update_b,
    bool released) {

    Engine oracle;
    Engine fast;
    require(oracle.prepare(sample_rate, 128, 0x5049454445434159ULL), "oracle prepare");
    require(fast.prepare(sample_rate, 128, 0x5049454445434159ULL), "fast prepare");
    oracle.set_modal_kernel(ModalKernel::Scalar);
    fast.set_modal_kernel(ModalKernel::Scalar);

    Patch patch = crystal_like(serial, reduced);
    oracle.set_patch(patch);
    fast.set_patch(patch);

    for (std::uint32_t i = 0; i < 8; ++i) {
        const NoteOn note{
            100U + i,
            static_cast<std::int16_t>(48 + i),
            0.58F + 0.05F * static_cast<float>(i),
            0.0F,
        };
        oracle.note_on(note);
        fast.note_on(note);
    }

    std::array<float, 128> oracle_left{};
    std::array<float, 128> oracle_right{};
    std::array<float, 128> fast_left{};
    std::array<float, 128> fast_right{};

    for (int block = 0; block < 8; ++block) {
        oracle.process(oracle_left.data(), oracle_right.data(), 128);
        fast.process(fast_left.data(), fast_right.data(), 128);
        require_block_equal(oracle_left, fast_left);
        require_block_equal(oracle_right, fast_right);
    }

    if (released) {
        for (std::uint32_t i = 0; i < 8; ++i) {
            oracle.note_off(100U + i);
            fast.note_off(100U + i);
        }
    }

    constexpr std::uint32_t ramp_frames = 576U;
    for (std::uint32_t frame = 0; frame < ramp_frames; ++frame) {
        const float t = static_cast<float>(frame)
            / static_cast<float>(ramp_frames - 1U);
        Patch next = patch;
        if (update_a) {
            next.resonator_a.decay_seconds = 4.5F + (0.65F - 4.5F) * t;
        }
        if (update_b) {
            next.resonator_b.decay_seconds = 16.2F + (2.1F - 16.2F) * t;
        }

        oracle.set_patch(next);
        fast.set_live_decay_patch(next, update_a, update_b);

        float oracle_l = 0.0F;
        float oracle_r = 0.0F;
        float fast_l = 0.0F;
        float fast_r = 0.0F;
        oracle.process(&oracle_l, &oracle_r, 1U);
        fast.process(&fast_l, &fast_r, 1U);

        require(bits(oracle_l) == bits(fast_l), "left sample mismatch");
        require(bits(oracle_r) == bits(fast_r), "right sample mismatch");
        patch = next;
    }

    for (int block = 0; block < 32; ++block) {
        oracle.process(oracle_left.data(), oracle_right.data(), 128);
        fast.process(fast_left.data(), fast_right.data(), 128);
        require_block_equal(oracle_left, fast_left);
        require_block_equal(oracle_right, fast_right);
    }
}

} // namespace

int main() {
    for (double sample_rate : {44100.0, 48000.0, 96000.0}) {
        for (bool serial : {false, true}) {
            compare_case(sample_rate, serial, false, true, false, false);
            compare_case(sample_rate, serial, false, false, true, false);
            compare_case(sample_rate, serial, false, true, true, true);
        }
    }

    // Quality-pruned banks must transparently fall back to generic configure.
    compare_case(48000.0, true, true, true, false, false);

    std::cout << "live_decay_bit_identity=ok\n";
    return 0;
}
