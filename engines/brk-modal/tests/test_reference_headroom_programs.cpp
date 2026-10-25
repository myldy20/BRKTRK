// Copyright © 2026 Myldy design / Ilya Tolstoukhov
// SPDX-License-Identifier: GPL-3.0-only

#include "brk_modal/brk_modal.hpp"
#include "brk_modal/ripplerx_programs.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>

#ifndef BRK_MODAL_PROGRAM_BANK_INCLUDE
#error "BRK_MODAL_PROGRAM_BANK_INCLUDE must name the generated RipplerX bank .inc file"
#endif

namespace brk::modal {
#include BRK_MODAL_PROGRAM_BANK_INCLUDE
} // namespace brk::modal

int main() {
    constexpr std::uint32_t rate = 48000U;
    constexpr std::uint32_t block = 128U;
    constexpr std::uint32_t frames = 12000U;
    constexpr std::array<std::int16_t, 8> keys = {60, 64, 67, 72, 76, 79, 84, 91};

    float global_maximum = 0.0F;
    const char* worst_name = "none";

    for (std::size_t program_index = 0; program_index < brk::modal::kRipplerXProgramCount; ++program_index) {
        const auto program = static_cast<brk::modal::RipplerXProgram>(program_index);
        brk::modal::Engine engine;
        if (!engine.prepare(rate, block, 0x4844524dU + program_index)) return 2;
        auto patch = brk::modal::make_ripplerx_program(program);
        patch.stereo_width = 1.0F;
        patch.polyphony = 8;
        engine.set_patch(patch);
        engine.set_reference_output_mode(brk::modal::ReferenceOutputMode::Normal);

        std::array<float, block> left{};
        std::array<float, block> right{};
        std::uint32_t cursor = 0U;
        for (std::size_t note = 0; note < keys.size(); ++note) {
            engine.note_on({static_cast<std::uint32_t>(note + 1U), keys[note], 1.0F, 0.0F});
        }
        while (cursor < frames) {
            if (cursor == 4096U) {
                for (std::size_t note = 0; note < keys.size(); ++note) {
                    engine.note_off(static_cast<std::uint32_t>(note + 1U));
                }
            }
            if (cursor == 6144U) {
                for (std::size_t note = 0; note < keys.size(); ++note) {
                    engine.note_on({static_cast<std::uint32_t>(101U + note),
                                    static_cast<std::int16_t>(keys[note] + 5), 1.0F, 0.0F});
                }
            }
            const auto count = std::min<std::uint32_t>(block, frames - cursor);
            engine.process(left.data(), right.data(), count);
            for (std::uint32_t frame = 0; frame < count; ++frame) {
                if (!std::isfinite(left[frame]) || !std::isfinite(right[frame])) return 3;
                const float maximum = std::max(std::abs(left[frame]), std::abs(right[frame]));
                if (maximum > global_maximum) {
                    global_maximum = maximum;
                    worst_name = brk::modal::ripplerx_program_name(program);
                }
            }
            cursor += count;
        }
    }

    std::cout << "reference_headroom_canonical_maximum=" << global_maximum << '\n';
    std::cout << "reference_headroom_canonical_worst=" << worst_name << '\n';
    if (!(global_maximum < 0.95F)) {
        std::cerr << "Reference canonical headroom exceeded 0.95 safety target\n";
        return 1;
    }
    return 0;
}
