#include "brk_modal_module_runtime.hpp"
#include "brk_modal/auto_quality.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>

namespace {

constexpr std::uint32_t kFrames = 128U;
constexpr double kSampleRate = 48000.0;
constexpr std::uint64_t kSeed = 0x50394d4f42494c45ULL;
constexpr std::size_t kEventBackingBytes = 64U;
static_assert(kEventBackingBytes >= sizeof(brk_note_event));
static_assert(kEventBackingBytes >= sizeof(brk_param_value_event));
static_assert(kEventBackingBytes >= sizeof(brk_param_ramp_event));
static_assert(kEventBackingBytes >= sizeof(brk_sustain_event));
using Buffer = std::array<float, kFrames>;
using EventBacking = std::array<std::uint8_t, kEventBackingBytes>;

EventBacking no_op_sustain_event() {
    brk_sustain_event event{};
    event.header.type = BRK_EVENT_SUSTAIN;
    event.header.size = sizeof(event);
    event.header.frame_offset = 0U;
    event.down = 0U;
    EventBacking bytes{};
    std::memcpy(bytes.data(), &event, sizeof(event));
    return bytes;
}

brk::modal::Patch benchmark_patch() {
    using namespace brk::modal;
    return apply_auto_quality_profile(
        make_factory_patch(FactoryPatch::DeepMembrane),
        QualityProfile::Balanced);
}

bool prepare_engine(brk::modal::Engine& engine) {
    if (!engine.prepare(kSampleRate, kFrames, kSeed)) return false;
    engine.set_patch(benchmark_patch());
    engine.note_on({1U, 52, 0.82F, 0.0F});
    return true;
}

std::int32_t render_block(brk::modal::abi::PersistentEventExecutor& executor,
                          brk::modal::Engine& engine,
                          bool force_sample_path,
                          Buffer& left,
                          Buffer& right) {
    if (!force_sample_path) {
        return executor.process(engine, left.data(), right.data(), kFrames, nullptr, 0U, 0U);
    }
    const auto bytes = no_op_sustain_event();
    // Keep the logical ABI event byte count exact while giving the optimizer a
    // parser-safe backing object large enough for every frozen v1 event layout.
    return executor.process(
        engine, left.data(), right.data(), kFrames,
        bytes.data(), static_cast<std::uint32_t>(sizeof(brk_sustain_event)), 1U);
}

double benchmark(bool force_sample_path) {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    Engine engine;
    if (!prepare_engine(engine)) return -1.0;
    PersistentEventExecutor executor;
    Buffer left{};
    Buffer right{};

    for (std::size_t block = 0; block < 64U; ++block) {
        if (render_block(executor, engine, force_sample_path, left, right) != BRK_OK) return -1.0;
    }

    constexpr std::size_t kMeasuredBlocks = 512U;
    const auto start = std::chrono::steady_clock::now();
    for (std::size_t block = 0; block < kMeasuredBlocks; ++block) {
        if (render_block(executor, engine, force_sample_path, left, right) != BRK_OK) return -1.0;
    }
    const auto stop = std::chrono::steady_clock::now();
    const double elapsed_microseconds = std::chrono::duration<double, std::micro>(stop - start).count();

    // Consume rendered output so the benchmark remains observable without
    // affecting the realtime path under test.
    if (!std::isfinite(left.back()) || !std::isfinite(right.back())) return -1.0;
    return elapsed_microseconds / static_cast<double>(kMeasuredBlocks);
}

} // namespace

int main() {
    using namespace brk::modal;
    using namespace brk::modal::abi;

    Engine block_engine;
    Engine sample_engine;
    if (!prepare_engine(block_engine) || !prepare_engine(sample_engine)) return 1;

    PersistentEventExecutor block_executor;
    PersistentEventExecutor sample_executor;
    Buffer block_left{};
    Buffer block_right{};
    Buffer sample_left{};
    Buffer sample_right{};

    double maximum_error = 0.0;
    for (std::size_t block = 0; block < 32U; ++block) {
        if (render_block(block_executor, block_engine, false, block_left, block_right) != BRK_OK) return 2;
        if (render_block(sample_executor, sample_engine, true, sample_left, sample_right) != BRK_OK) return 3;
        if (block_executor.active_ramp_count() != 0U || sample_executor.active_ramp_count() != 0U) return 4;
        for (std::size_t frame = 0; frame < kFrames; ++frame) {
            if (!std::isfinite(block_left[frame]) || !std::isfinite(block_right[frame])
                || !std::isfinite(sample_left[frame]) || !std::isfinite(sample_right[frame])) return 5;
            maximum_error = std::max(maximum_error,
                static_cast<double>(std::abs(block_left[frame] - sample_left[frame])));
            maximum_error = std::max(maximum_error,
                static_cast<double>(std::abs(block_right[frame] - sample_right[frame])));
        }
    }

    // The engine contract is variable-block-size capable. A tiny floating-point
    // tolerance is retained here so future quality-neutral vector backends do
    // not turn this executor regression into a false bit-identity requirement.
    if (maximum_error > 1.0e-6) return 6;

    const double block_microseconds = benchmark(false);
    const double sample_microseconds = benchmark(true);
    if (!(block_microseconds > 0.0) || !(sample_microseconds > 0.0)) return 7;

    std::cout << "p9e_event_free_block_fast_path=ok\n";
    std::cout << "p9e_event_free_block_max_error=" << maximum_error << "\n";
    std::cout << "p9e_event_free_block_us=" << block_microseconds << "\n";
    std::cout << "p9e_forced_sample_block_us=" << sample_microseconds << "\n";
    std::cout << "p9e_event_free_block_ratio=" << (block_microseconds / sample_microseconds) << "\n";
    return 0;
}
