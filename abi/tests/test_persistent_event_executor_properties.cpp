#include "brk_modal_module_runtime.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>

namespace {

constexpr std::uint32_t kFrames = 64U;
constexpr std::uint64_t kSeed = 0x5038455845435554ULL;

template <typename T>
void append(std::vector<std::uint8_t>& bytes, const T& value) {
    const auto* source = reinterpret_cast<const std::uint8_t*>(&value);
    bytes.insert(bytes.end(), source, source + sizeof(T));
}

brk_event_header header(std::uint16_t type, std::uint16_t size, std::uint32_t frame) {
    brk_event_header value{};
    value.type = type;
    value.size = size;
    value.frame_offset = frame;
    return value;
}

brk_param_value_event parameter(std::uint32_t frame, brk::modal::ParameterId id, float normalized) {
    brk_param_value_event value{};
    value.header = header(BRK_EVENT_PARAM_VALUE, sizeof(value), frame);
    value.parameter_id = static_cast<std::uint32_t>(id);
    value.normalized_value = normalized;
    value.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    return value;
}

brk_param_ramp_event ramp(std::uint32_t frame,
                          brk::modal::ParameterId id,
                          float start,
                          float end,
                          std::uint32_t duration) {
    brk_param_ramp_event value{};
    value.header = header(BRK_EVENT_PARAM_RAMP, sizeof(value), frame);
    value.parameter_id = static_cast<std::uint32_t>(id);
    value.start_normalized = start;
    value.end_normalized = end;
    value.duration_frames = duration;
    value.note_id = BRK_SYNTH_GLOBAL_NOTE_ID;
    return value;
}

std::vector<std::uint8_t> reset_packet() {
    std::vector<std::uint8_t> bytes;
    append(bytes, header(BRK_EVENT_RESET, sizeof(brk_event_header), 0U));
    return bytes;
}

struct RenderResult {
    std::int32_t status = BRK_ERROR_INTERNAL;
    std::array<float, kFrames> left{};
    std::array<float, kFrames> right{};
};

RenderResult process(brk::modal::abi::PersistentEventExecutor& executor,
                     brk::modal::Engine& engine,
                     const std::vector<std::uint8_t>& events,
                     std::uint32_t event_count) {
    RenderResult result{};
    result.left.fill(123.0F);
    result.right.fill(-123.0F);
    result.status = executor.process(
        engine,
        result.left.data(),
        result.right.data(),
        kFrames,
        events.empty() ? nullptr : events.data(),
        static_cast<std::uint32_t>(events.size()),
        event_count);
    return result;
}

bool finite_output(const RenderResult& result) {
    return std::all_of(result.left.begin(), result.left.end(), [](float value) { return std::isfinite(value); })
        && std::all_of(result.right.begin(), result.right.end(), [](float value) { return std::isfinite(value); });
}

bool untouched_output(const RenderResult& result) {
    return std::all_of(result.left.begin(), result.left.end(), [](float value) { return value == 123.0F; })
        && std::all_of(result.right.begin(), result.right.end(), [](float value) { return value == -123.0F; });
}

bool buffers_equal(const RenderResult& a, const RenderResult& b) {
    return a.status == b.status && a.left == b.left && a.right == b.right;
}

bool same_bits(float left, float right) noexcept {
    return std::memcmp(&left, &right, sizeof(float)) == 0;
}

float normalized(const brk::modal::Engine& engine, brk::modal::ParameterId id) {
    float value = -1.0F;
    if (!brk::modal::get_parameter_normalized(engine.patch(), id, value)) return -1.0F;
    return value;
}

std::uint32_t xorshift32(std::uint32_t& state) noexcept {
    state ^= state << 13U;
    state ^= state >> 17U;
    state ^= state << 5U;
    return state;
}

bool prepare(brk::modal::Engine& engine, std::uint64_t seed) {
    return engine.prepare(48000.0, kFrames, seed);
}

std::vector<brk::modal::ParameterId> parameter_ids(std::size_t count) {
    using namespace brk::modal;
    const auto available = sizeof(parameter_detail::kDescriptors) / sizeof(parameter_detail::kDescriptors[0]);
    if (available < count) return {};
    std::vector<ParameterId> ids;
    ids.reserve(count);
    for (std::size_t index = 0U; index < count; ++index) {
        ids.push_back(parameter_detail::kDescriptors[index].id);
    }
    return ids;
}

constexpr std::array<brk::modal::ParameterId, 9> kSampleAccurateIds{{
    brk::modal::ParameterId::ADecaySeconds,
    brk::modal::ParameterId::AMaterial,
    brk::modal::ParameterId::ATone,
    brk::modal::ParameterId::BDecaySeconds,
    brk::modal::ParameterId::BMaterial,
    brk::modal::ParameterId::BTone,
    brk::modal::ParameterId::StereoWidth,
    brk::modal::ParameterId::ResonatorGainDb,
    brk::modal::ParameterId::OutputGainDb,
}};

bool cross_block_ramp() {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    Engine engine;
    PersistentEventExecutor executor;
    if (!prepare(engine, kSeed)) return false;

    std::vector<std::uint8_t> first;
    append(first, ramp(32U, ParameterId::OutputGainDb, 0.1F, 0.9F, 96U));
    const auto block0 = process(executor, engine, first, 1U);
    if (block0.status != BRK_OK || !finite_output(block0) || executor.active_ramp_count() != 1U) return false;

    const auto block1 = process(executor, engine, {}, 0U);
    if (block1.status != BRK_OK || !finite_output(block1) || executor.active_ramp_count() != 0U) return false;
    return std::abs(normalized(engine, ParameterId::OutputGainDb) - 0.9F) <= 1.0e-5F;
}

bool same_parameter_conflict_and_boundary() {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    Engine engine;
    PersistentEventExecutor executor;
    if (!prepare(engine, kSeed + 1U)) return false;

    std::vector<std::uint8_t> first;
    append(first, ramp(0U, ParameterId::OutputGainDb, 0.2F, 0.8F, 96U));
    if (process(executor, engine, first, 1U).status != BRK_OK || executor.active_ramp_count() != 1U) return false;

    std::vector<std::uint8_t> overlap;
    append(overlap, ramp(31U, ParameterId::OutputGainDb, 0.8F, 0.1F, 8U));
    const auto rejected_ramp = process(executor, engine, overlap, 1U);
    if (rejected_ramp.status != BRK_ERROR_BAD_EVENT || !untouched_output(rejected_ramp)
        || executor.active_ramp_count() != 1U) return false;

    std::vector<std::uint8_t> value_inside;
    append(value_inside, parameter(31U, ParameterId::OutputGainDb, 0.5F));
    const auto rejected_value = process(executor, engine, value_inside, 1U);
    if (rejected_value.status != BRK_ERROR_BAD_EVENT || !untouched_output(rejected_value)
        || executor.active_ramp_count() != 1U) return false;

    std::vector<std::uint8_t> boundary;
    append(boundary, ramp(32U, ParameterId::OutputGainDb, 0.8F, 0.4F, 8U));
    const auto accepted = process(executor, engine, boundary, 1U);
    return accepted.status == BRK_OK && finite_output(accepted)
        && executor.active_ramp_count() == 0U
        && std::abs(normalized(engine, ParameterId::OutputGainDb) - 0.4F) <= 1.0e-5F;
}

bool reset_clears_persistent_ramps() {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    Engine engine;
    PersistentEventExecutor executor;
    if (!prepare(engine, kSeed + 2U)) return false;

    std::vector<std::uint8_t> first;
    append(first, ramp(0U, ParameterId::StereoWidth, 0.0F, 1.0F, 128U));
    if (process(executor, engine, first, 1U).status != BRK_OK || executor.active_ramp_count() != 1U) return false;

    const auto reset = process(executor, engine, reset_packet(), 1U);
    if (reset.status != BRK_OK || !finite_output(reset) || executor.active_ramp_count() != 0U) return false;

    std::vector<std::uint8_t> replacement;
    append(replacement, ramp(0U, ParameterId::StereoWidth, 1.0F, 0.25F, 8U));
    const auto after = process(executor, engine, replacement, 1U);
    return after.status == BRK_OK && finite_output(after) && executor.active_ramp_count() == 0U;
}

bool realtime_ramp_set_and_recovery() {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    Engine engine;
    PersistentEventExecutor executor;
    if (!prepare(engine, kSeed + 3U)) return false;

    std::vector<std::uint8_t> fill;
    for (std::size_t index = 0U; index < kSampleAccurateIds.size(); ++index) {
        const float start = 0.15F + static_cast<float>(index) * 0.01F;
        const float end = 0.75F - static_cast<float>(index) * 0.01F;
        append(fill, ramp(0U, kSampleAccurateIds[index], start, end, 65U));
    }
    const auto filled = process(executor, engine, fill, static_cast<std::uint32_t>(kSampleAccurateIds.size()));
    if (filled.status != BRK_OK || !finite_output(filled)
        || executor.active_ramp_count() != kSampleAccurateIds.size()) return false;

    std::vector<std::uint8_t> overlap;
    append(overlap, ramp(0U, ParameterId::OutputGainDb, 0.2F, 0.8F, 8U));
    const auto rejected = process(executor, engine, overlap, 1U);
    if (rejected.status != BRK_ERROR_BAD_EVENT || !untouched_output(rejected)
        || executor.active_ramp_count() != kSampleAccurateIds.size()) return false;

    const auto drain = process(executor, engine, {}, 0U);
    if (drain.status != BRK_OK || !finite_output(drain) || executor.active_ramp_count() != 0U) return false;

    const auto recovered = process(executor, engine, overlap, 1U);
    return recovered.status == BRK_OK && finite_output(recovered) && executor.active_ramp_count() == 0U;
}

bool explicit_automation_policy() {
    using namespace brk::modal;
    using namespace brk::modal::abi;

    for (const auto id : kSampleAccurateIds) {
        const auto* descriptor = parameter_descriptor(id);
        if (descriptor == nullptr || !parameter_supports_sample_accurate_events(*descriptor)) return false;
    }
    const auto* hit = parameter_descriptor(ParameterId::AHitPosition);
    const auto* partials = parameter_descriptor(ParameterId::APartials);
    if (hit == nullptr || partials == nullptr
        || !parameter_supports_block_value(*hit)
        || parameter_supports_sample_accurate_events(*hit)
        || !parameter_supports_block_value(*partials)
        || parameter_supports_sample_accurate_events(*partials)
        || (partials->flags & ParameterRequiresReconfigure) == 0U) return false;

    Engine engine;
    PersistentEventExecutor executor;
    if (!prepare(engine, kSeed + 4U)) return false;
    const float original_hit = normalized(engine, ParameterId::AHitPosition);
    const float original_partials = normalized(engine, ParameterId::APartials);

    std::vector<std::uint8_t> forbidden_ramp;
    append(forbidden_ramp, ramp(0U, ParameterId::AHitPosition, 0.2F, 0.8F, 16U));
    const auto ramp_rejected = process(executor, engine, forbidden_ramp, 1U);
    if (ramp_rejected.status != BRK_ERROR_BAD_EVENT || !untouched_output(ramp_rejected)
        || normalized(engine, ParameterId::AHitPosition) != original_hit) return false;

    std::vector<std::uint8_t> late_value;
    append(late_value, parameter(17U, ParameterId::AHitPosition, 0.8F));
    const auto late_rejected = process(executor, engine, late_value, 1U);
    if (late_rejected.status != BRK_ERROR_BAD_EVENT || !untouched_output(late_rejected)
        || normalized(engine, ParameterId::AHitPosition) != original_hit) return false;

    std::vector<std::uint8_t> structural_ramp;
    append(structural_ramp, ramp(0U, ParameterId::APartials, 0.2F, 0.8F, 16U));
    const auto structural_rejected = process(executor, engine, structural_ramp, 1U);
    if (structural_rejected.status != BRK_ERROR_BAD_EVENT || !untouched_output(structural_rejected)
        || normalized(engine, ParameterId::APartials) != original_partials) return false;

    std::vector<std::uint8_t> boundary_values;
    append(boundary_values, parameter(0U, ParameterId::AHitPosition, 0.8F));
    append(boundary_values, parameter(0U, ParameterId::APartials, 1.0F));
    const auto accepted = process(executor, engine, boundary_values, 2U);
    return accepted.status == BRK_OK && finite_output(accepted)
        && std::abs(normalized(engine, ParameterId::AHitPosition) - 0.8F) <= 1.0e-5F
        && std::abs(normalized(engine, ParameterId::APartials) - 1.0F) <= 1.0e-5F;
}

bool gain_fast_path_exact_oracle() {
    using namespace brk::modal;
    Engine oracle;
    Engine fast;
    if (!prepare(oracle, kSeed + 5U) || !prepare(fast, kSeed + 5U)) return false;

    auto patch = make_factory_patch(FactoryPatch::RitualBell);
    patch.polyphony = 4U;
    patch.resonator_a.partials = 24U;
    patch.resonator_b.partials = 16U;
    oracle.set_patch(patch);
    fast.set_patch(patch);
    constexpr std::array<std::int16_t, 4> keys{60, 67, 72, 79};
    for (std::size_t index = 0U; index < keys.size(); ++index) {
        const NoteOn note{static_cast<std::uint32_t>(index + 1U), keys[index], 0.9F, 0.0F};
        oracle.note_on(note);
        fast.note_on(note);
    }

    float oracle_left = 0.0F;
    float oracle_right = 0.0F;
    float fast_left = 0.0F;
    float fast_right = 0.0F;
    for (std::uint32_t frame = 0U; frame < 256U; ++frame) {
        const float phase = static_cast<float>(frame % 64U) / 63.0F;
        patch.output_gain_db = -18.0F + 15.0F * phase;
        patch.resonator_gain_db = -12.0F + 18.0F * (1.0F - phase);
        oracle.set_patch(patch);
        fast.set_live_gain_patch(patch, true, true);
        oracle.process(&oracle_left, &oracle_right, 1U);
        fast.process(&fast_left, &fast_right, 1U);
        if (!same_bits(oracle_left, fast_left) || !same_bits(oracle_right, fast_right)) return false;
    }
    return true;
}

bool module_runtime_cross_block() {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    ModuleRuntime runtime;
    const auto raw_handle = runtime.create(0U);
    if (raw_handle <= 0) return false;
    const auto handle = static_cast<brk_instance_handle>(raw_handle);

    brk_prepare_info info{};
    info.struct_size = sizeof(info);
    info.sample_rate = 48000.0;
    info.max_block_frames = kFrames;
    info.max_events_per_block = 128U;
    info.output_channel_count = 2U;
    info.realtime_memory_limit_bytes = kRealtimeMemoryEstimateBytes;
    info.deterministic_seed_lo = static_cast<std::uint32_t>(kSeed + 6U);
    info.deterministic_seed_hi = static_cast<std::uint32_t>((kSeed + 6U) >> 32U);
    if (runtime.prepare(handle, info) != BRK_OK || runtime.activate(handle) != BRK_OK) return false;

    std::vector<std::uint8_t> events;
    append(events, ramp(0U, ParameterId::ResonatorGainDb, 0.1F, 0.7F, 96U));
    std::array<float, kFrames> left{};
    std::array<float, kFrames> right{};
    if (runtime.process(handle, left.data(), right.data(), kFrames,
                        events.data(), static_cast<std::uint32_t>(events.size()), 1U) != BRK_OK
        || runtime.active_ramp_count(handle) != 1U) return false;
    if (runtime.process(handle, left.data(), right.data(), kFrames, nullptr, 0U, 0U) != BRK_OK
        || runtime.active_ramp_count(handle) != 0U) return false;
    const auto* engine = runtime.engine(handle);
    return engine != nullptr
        && std::abs(normalized(*engine, ParameterId::ResonatorGainDb) - 0.7F) <= 1.0e-5F;
}

bool stateful_deterministic_property() {
    using namespace brk::modal;
    using namespace brk::modal::abi;
    const auto ids = parameter_ids(12U);
    if (ids.size() != 12U) return false;

    Engine a;
    Engine b;
    PersistentEventExecutor executor_a;
    PersistentEventExecutor executor_b;
    if (!prepare(a, kSeed + 7U) || !prepare(b, kSeed + 7U)) return false;

    constexpr std::uint32_t kBlocks = 512U;
    std::uint32_t rng = 0x5038465AU;
    std::uint32_t accepted = 0U;
    std::uint32_t rejected = 0U;
    for (std::uint32_t block = 0U; block < kBlocks; ++block) {
        std::vector<std::uint8_t> events;
        std::uint32_t count = 0U;
        const auto operation = xorshift32(rng) % 5U;
        if (operation == 1U) {
            const auto id = ids[xorshift32(rng) % ids.size()];
            const float value = static_cast<float>(xorshift32(rng) % 1001U) / 1000.0F;
            append(events, parameter(xorshift32(rng) % kFrames, id, value));
            count = 1U;
        } else if (operation == 2U || operation == 3U) {
            const auto id = ids[xorshift32(rng) % ids.size()];
            const float start = static_cast<float>(xorshift32(rng) % 1001U) / 1000.0F;
            const float end = static_cast<float>(xorshift32(rng) % 1001U) / 1000.0F;
            const std::uint32_t duration = 1U + (xorshift32(rng) % 192U);
            append(events, ramp(xorshift32(rng) % kFrames, id, start, end, duration));
            count = 1U;
        } else if (operation == 4U) {
            events = reset_packet();
            count = 1U;
        }

        const auto result_a = process(executor_a, a, events, count);
        const auto result_b = process(executor_b, b, events, count);
        if (!buffers_equal(result_a, result_b)
            || executor_a.active_ramp_count() != executor_b.active_ramp_count()
            || executor_a.active_ramp_count() > kMaxPersistentRamps) return false;

        if (result_a.status == BRK_OK) {
            ++accepted;
            if (!finite_output(result_a)) return false;
        } else {
            ++rejected;
            if (result_a.status != BRK_ERROR_BAD_EVENT || !untouched_output(result_a)) return false;
        }

        for (const auto id : ids) {
            if (normalized(a, id) != normalized(b, id)) return false;
        }
    }

    if (accepted == 0U || rejected == 0U) return false;
    std::cout << "persistent_property_blocks=" << kBlocks << '\n';
    std::cout << "persistent_property_accepted=" << accepted << '\n';
    std::cout << "persistent_property_rejected=" << rejected << '\n';
    return true;
}

} // namespace

int main() {
    if (!cross_block_ramp()) return 1;
    std::cout << "persistent_cross_block_ramp=PASS\n";
    if (!same_parameter_conflict_and_boundary()) return 2;
    std::cout << "persistent_same_parameter_conflict=PASS\n";
    if (!reset_clears_persistent_ramps()) return 3;
    std::cout << "persistent_reset_clears_ramps=PASS\n";
    if (!realtime_ramp_set_and_recovery()) return 4;
    std::cout << "persistent_realtime_ramp_set_recovery=PASS\n";
    if (!explicit_automation_policy()) return 5;
    std::cout << "persistent_explicit_automation_policy=PASS\n";
    if (!gain_fast_path_exact_oracle()) return 6;
    std::cout << "persistent_gain_fast_path_exact_oracle=PASS\n";
    if (!module_runtime_cross_block()) return 7;
    std::cout << "module_runtime_cross_block_ramp=PASS\n";
    if (!stateful_deterministic_property()) return 8;
    std::cout << "persistent_stateful_property=PASS\n";
    std::cout << "brk_persistent_event_executor_properties=PASS\n";
    return 0;
}