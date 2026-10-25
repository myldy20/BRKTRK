#include "brk_modal/brk_modal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {

constexpr std::uint32_t kFrames = 128U;
constexpr std::size_t kBlocks = 48U;

struct Render {
    std::vector<float> left;
    std::vector<float> right;
    brk::modal::ModalKernel active_kernel = brk::modal::ModalKernel::Scalar;
};

struct ErrorMetrics {
    double maximum = 0.0;
    double rms = 0.0;
    double signal_rms = 0.0;
    double snr_db = 0.0;
};

brk::modal::Patch dense_parallel_patch() {
    auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::SoftPlate);
    patch.resonator_a.partials = 61U;
    patch.resonator_a.max_render_partials = 61U;
    patch.resonator_b.enabled = true;
    patch.resonator_b.model = brk::modal::Model::Beam;
    patch.resonator_b.partials = 37U;
    patch.resonator_b.max_render_partials = 37U;
    patch.resonator_b.decay_seconds = 2.1F;
    patch.parallel_mix = 0.37F;
    patch.polyphony = 8U;
    patch.stereo_mode = brk::modal::StereoMode::VoiceSpread;
    return patch;
}

brk::modal::Patch dense_serial_patch() {
    auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::RitualBell);
    patch.resonator_a.partials = 64U;
    patch.resonator_a.max_render_partials = 64U;
    patch.resonator_b.partials = 43U;
    patch.resonator_b.max_render_partials = 43U;
    patch.polyphony = 6U;
    return patch;
}

brk::modal::Patch reduced_tail_patch() {
    auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::DeepMembrane);
    patch.resonator_a.max_render_partials = 31U;
    patch.resonator_b.max_render_partials = 19U;
    patch.polyphony = 5U;
    patch.stereo_mode = brk::modal::StereoMode::Mono;
    return patch;
}

void apply_events(brk::modal::Engine& engine, std::size_t block) {
    if (block == 5U) engine.set_sustain(true);
    if (block == 7U) engine.note_off(2U);
    if (block == 9U) engine.note_on({2U, 58, 0.64F, 0.0F});
    if (block == 13U) engine.set_sustain(false);
    if (block == 17U) engine.note_off(1U);
    if (block == 20U) engine.note_on({1U, 50, 0.91F, 0.0F});
    if (block == 26U) engine.choke(3U);
    if (block == 31U) engine.note_off(4U);
}

Render render(
    const brk::modal::Patch& patch,
    brk::modal::ModalKernel initial_kernel,
    std::size_t switch_block = kBlocks,
    brk::modal::ModalKernel switched_kernel = brk::modal::ModalKernel::Scalar) {

    brk::modal::Engine engine;
    if (!engine.prepare(48000.0, kFrames, 0x5034374256454354ULL)) {
        throw std::runtime_error("prepare failed");
    }
    engine.set_modal_kernel(initial_kernel);
    engine.set_patch(patch);
    engine.note_on({1U, 43, 0.82F, 0.0F});
    engine.note_on({2U, 50, 0.71F, 0.0F});
    engine.note_on({3U, 55, 0.63F, -0.07F});
    engine.note_on({4U, 62, 0.94F, 0.04F});

    Render result;
    result.left.reserve(kBlocks * kFrames);
    result.right.reserve(kBlocks * kFrames);
    std::array<float, kFrames> left{};
    std::array<float, kFrames> right{};

    for (std::size_t block = 0; block < kBlocks; ++block) {
        apply_events(engine, block);
        if (block == switch_block) engine.set_modal_kernel(switched_kernel);
        engine.process(left.data(), right.data(), kFrames);
        result.left.insert(result.left.end(), left.begin(), left.end());
        result.right.insert(result.right.end(), right.begin(), right.end());
    }
    result.active_kernel = engine.active_modal_kernel();
    return result;
}

ErrorMetrics compare(const Render& reference, const Render& candidate) {
    if (reference.left.size() != candidate.left.size() || reference.right.size() != candidate.right.size()) {
        throw std::runtime_error("render size mismatch");
    }
    long double squared = 0.0;
    long double signal_squared = 0.0;
    std::size_t count = 0U;
    double maximum = 0.0;
    const auto accumulate = [&](const std::vector<float>& a, const std::vector<float>& b) {
        for (std::size_t index = 0; index < a.size(); ++index) {
            const double error = std::abs(static_cast<double>(a[index]) - static_cast<double>(b[index]));
            maximum = std::max(maximum, error);
            squared += static_cast<long double>(error * error);
            signal_squared += static_cast<long double>(static_cast<double>(a[index]) * static_cast<double>(a[index]));
            ++count;
        }
    };
    accumulate(reference.left, candidate.left);
    accumulate(reference.right, candidate.right);
    const double rms = std::sqrt(static_cast<double>(squared / static_cast<long double>(count)));
    const double signal_rms = std::sqrt(static_cast<double>(signal_squared / static_cast<long double>(count)));
    const double snr_db = rms > 0.0 ? 20.0 * std::log10(signal_rms / rms) : 300.0;
    return {maximum, rms, signal_rms, snr_db};
}

void require_close(const char* label, const ErrorMetrics& metrics) {
    constexpr double kMaximumLimit = 3.0e-5;
    constexpr double kRmsLimit = 5.0e-6;
    constexpr double kMinimumSnrDb = 85.0;
    if (metrics.maximum > kMaximumLimit || metrics.rms > kRmsLimit || metrics.snr_db < kMinimumSnrDb) {
        std::cerr << label << " max=" << metrics.maximum << " rms=" << metrics.rms
                  << " snr_db=" << metrics.snr_db << '\n';
        throw std::runtime_error("modal kernel audio mismatch");
    }
}

} // namespace

int main() {
    try {
        const bool vector_available = brk::modal::modal_vector_kernel_available();
        brk::modal::Engine probe;
        if (!probe.prepare(48000.0, kFrames, 1U)) throw std::runtime_error("probe prepare failed");
        probe.set_modal_kernel(brk::modal::ModalKernel::Auto);
        const auto expected_auto = vector_available
            ? brk::modal::ModalKernel::Vector4
            : brk::modal::ModalKernel::Scalar;
        if (probe.active_modal_kernel() != expected_auto) throw std::runtime_error("Auto kernel resolution mismatch");

        const std::array<brk::modal::Patch, 3> patches{
            dense_parallel_patch(),
            dense_serial_patch(),
            reduced_tail_patch(),
        };

        double worst_maximum = 0.0;
        double worst_rms = 0.0;
        double worst_snr_db = 300.0;
        for (std::size_t index = 0; index < patches.size(); ++index) {
            const auto scalar = render(patches[index], brk::modal::ModalKernel::Scalar);
            const auto vector = render(patches[index], brk::modal::ModalKernel::Vector4);
            const auto switched = render(
                patches[index],
                brk::modal::ModalKernel::Scalar,
                12U,
                brk::modal::ModalKernel::Vector4);

            if (scalar.active_kernel != brk::modal::ModalKernel::Scalar) {
                throw std::runtime_error("Scalar kernel did not remain active");
            }
            if (vector.active_kernel != expected_auto || switched.active_kernel != expected_auto) {
                throw std::runtime_error("Vector kernel resolution mismatch");
            }

            const auto vector_error = compare(scalar, vector);
            const auto switch_error = compare(scalar, switched);
            require_close("fresh scalar/vector", vector_error);
            require_close("mid-tail scalar/vector switch", switch_error);
            worst_maximum = std::max({worst_maximum, vector_error.maximum, switch_error.maximum});
            worst_rms = std::max({worst_rms, vector_error.rms, switch_error.rms});
            worst_snr_db = std::min({worst_snr_db, vector_error.snr_db, switch_error.snr_db});
        }

        std::cout << "vector_available=" << (vector_available ? "true" : "false") << '\n';
        std::cout << "auto_kernel=" << brk::modal::modal_kernel_name(expected_auto) << '\n';
        std::cout << "worst_max_abs_error=" << worst_maximum << '\n';
        std::cout << "worst_rms_error=" << worst_rms << '\n';
        std::cout << "worst_snr_db=" << worst_snr_db << '\n';
        std::cout << "mid_tail_switch=ok\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "brk_modal_kernel_tests: " << error.what() << '\n';
        return 1;
    }
}
