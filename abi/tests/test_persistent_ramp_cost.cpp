#include "brk_modal_module_runtime.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string_view>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
using brk::modal::ParameterId;
using brk::modal::abi::PersistentEventExecutor;

constexpr std::uint32_t kRate = 48000U;
constexpr std::uint32_t kFrames = 64U;
constexpr std::uint64_t kSeed = 0x52414d50434f5354ULL;
constexpr double kMaxSampleAccurateRampOverValue = 32.0;
constexpr double kMaxSampleAccurateRealtimeFactor = 3.0;
volatile double g_output_sink = 0.0;

template <typename T>
void append(std::vector<std::uint8_t>& bytes, const T& value) {
    const auto* source = reinterpret_cast<const std::uint8_t*>(&value);
    bytes.insert(bytes.end(), source, source + sizeof(T));
}

brk_event_header header(std::uint16_t type, std::uint16_t size) {
    brk_event_header value{};
    value.type = type;
    value.size = size;
    value.frame_offset = 0U;
    return value;
}

std::vector<std::uint8_t> value_packet(ParameterId id, float normalized) {
    brk_param_value_event value{};
    value.header = header(BRK_EVENT_PARAM_VALUE, sizeof(value));
    value.parameter_id = static_cast<std::uint32_t>(id);
    value.normalized_value = normalized;
    value.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    std::vector<std::uint8_t> bytes;
    append(bytes, value);
    return bytes;
}

std::vector<std::uint8_t> ramp_packet(ParameterId id, float start, float end) {
    brk_param_ramp_event value{};
    value.header = header(BRK_EVENT_PARAM_RAMP, sizeof(value));
    value.parameter_id = static_cast<std::uint32_t>(id);
    value.start_normalized = start;
    value.end_normalized = end;
    value.duration_frames = kFrames;
    value.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    std::vector<std::uint8_t> bytes;
    append(bytes, value);
    return bytes;
}

struct Harness {
    brk::modal::Engine engine;
    PersistentEventExecutor executor;
    std::array<float, kFrames> left{};
    std::array<float, kFrames> right{};

    bool prepare() {
        if (!engine.prepare(kRate, kFrames, kSeed)) return false;
        auto patch = brk::modal::make_factory_patch(brk::modal::FactoryPatch::RitualBell);
        patch.polyphony = 4;
        patch.resonator_a.partials = 32;
        patch.resonator_b.partials = 24;
        engine.set_patch(patch);
        constexpr std::array<std::int16_t, 4> keys{60, 67, 72, 79};
        for (std::size_t index = 0U; index < keys.size(); ++index) {
            engine.note_on({static_cast<std::uint32_t>(index + 1U), keys[index], 0.9F, 0.0F});
        }
        for (int warm = 0; warm < 4; ++warm) {
            engine.process(left.data(), right.data(), kFrames);
        }
        return true;
    }

    bool process(const std::vector<std::uint8_t>& packet) {
        const auto status = executor.process(
            engine, left.data(), right.data(), kFrames,
            packet.data(), static_cast<std::uint32_t>(packet.size()), 1U);
        if (status != BRK_OK || executor.active_ramp_count() != 0U) return false;
        for (std::size_t index = 0U; index < kFrames; ++index) {
            if (!std::isfinite(left[index]) || !std::isfinite(right[index])) return false;
        }
        g_output_sink += static_cast<double>(left.back()) + static_cast<double>(right.back());
        return true;
    }
};

enum class Mode { Value, Ramp };

struct Measurement {
    double milliseconds = 0.0;
    double realtime_factor = 0.0;
};

Measurement measure_once(ParameterId id, Mode mode, std::uint32_t blocks) {
    Harness harness;
    if (!harness.prepare()) return {-1.0, -1.0};
    const auto low_value = value_packet(id, 0.25F);
    const auto high_value = value_packet(id, 0.75F);
    const auto up_ramp = ramp_packet(id, 0.25F, 0.75F);
    const auto down_ramp = ramp_packet(id, 0.75F, 0.25F);

    const auto begin = Clock::now();
    for (std::uint32_t block = 0U; block < blocks; ++block) {
        const bool odd = (block & 1U) != 0U;
        const auto& packet = mode == Mode::Ramp
            ? (odd ? down_ramp : up_ramp)
            : (odd ? low_value : high_value);
        if (!harness.process(packet)) return {-1.0, -1.0};
    }
    const double elapsed_ms = std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
    const double audio_ms = 1000.0 * static_cast<double>(blocks) * static_cast<double>(kFrames)
        / static_cast<double>(kRate);
    return {elapsed_ms, elapsed_ms / audio_ms};
}

Measurement median_measurement(ParameterId id, Mode mode, bool sanitizer) {
    const std::uint32_t blocks = sanitizer ? 8U : 64U;
    const std::size_t trials = sanitizer ? 1U : 5U;
    std::vector<Measurement> rows;
    rows.reserve(trials);
    for (std::size_t trial = 0U; trial < trials; ++trial) {
        const auto row = measure_once(id, mode, blocks);
        if (!(row.milliseconds > 0.0) || !(row.realtime_factor >= 0.0)) return {-1.0, -1.0};
        rows.push_back(row);
    }
    std::sort(rows.begin(), rows.end(), [](const Measurement& left, const Measurement& right) {
        return left.milliseconds < right.milliseconds;
    });
    return rows[rows.size() / 2U];
}

struct Case {
    std::string_view name;
    ParameterId id;
};

bool descriptor_contract(const Case& test_case) {
    const auto* descriptor = brk::modal::parameter_descriptor(test_case.id);
    return descriptor != nullptr
        && brk::modal::parameter_supports_sample_accurate_events(*descriptor);
}

bool run_case(const Case& test_case, bool sanitizer) {
    if (!descriptor_contract(test_case)) return false;
    const auto value = median_measurement(test_case.id, Mode::Value, sanitizer);
    const auto ramp = median_measurement(test_case.id, Mode::Ramp, sanitizer);
    if (!(value.milliseconds > 0.0) || !(ramp.milliseconds > 0.0)) return false;
    const double ratio = ramp.milliseconds / value.milliseconds;

    std::cout << test_case.name << "_value_ms=" << value.milliseconds << '\n';
    std::cout << test_case.name << "_ramp_ms=" << ramp.milliseconds << '\n';
    std::cout << test_case.name << "_ramp_over_value=" << ratio << '\n';
    std::cout << test_case.name << "_ramp_realtime_factor=" << ramp.realtime_factor << '\n';

    if (sanitizer) return true;
    return ratio <= kMaxSampleAccurateRampOverValue
        && ramp.realtime_factor <= kMaxSampleAccurateRealtimeFactor;
}

} // namespace

int main() {
    const bool sanitizer = std::getenv("ASAN_OPTIONS") != nullptr
        || std::getenv("UBSAN_OPTIONS") != nullptr;
    std::cout << "ramp_cost_sanitizer_mode=" << (sanitizer ? "true" : "false") << '\n';
    std::cout << "ramp_cost_sample_accurate_ratio_limit=" << kMaxSampleAccurateRampOverValue << '\n';
    std::cout << "ramp_cost_sample_accurate_realtime_limit=" << kMaxSampleAccurateRealtimeFactor << '\n';

    const std::array<Case, 3> cases{{
        {"output_gain", ParameterId::OutputGainDb},
        {"resonator_gain", ParameterId::ResonatorGainDb},
        {"stereo_width_control", ParameterId::StereoWidth},
    }};
    for (const auto& test_case : cases) {
        if (!run_case(test_case, sanitizer)) {
            std::cerr << "sample-accurate ramp cost regression failed for " << test_case.name << '\n';
            return 1;
        }
    }

    std::cout << "output_gain_sample_accurate_ramp_cost=PASS\n";
    std::cout << "resonator_gain_sample_accurate_ramp_cost=PASS\n";
    std::cout << "stereo_width_sample_accurate_control=PASS\n";
    std::cout << "brk_persistent_ramp_cost_regression=PASS\n";
    return 0;
}