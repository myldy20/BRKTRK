#pragma once

#include "brk_modal/brk_modal.hpp"

#include <cstddef>
#include <cstdint>

namespace brk::modal {

constexpr std::size_t kRipplerXProgramCount = 28;

enum class RipplerXProgram : std::uint8_t {
    Init = 0,
    Harpsi,
    Harp,
    Sankyo,
    Tubes,
    Stars,
    DoorBell,
    Bells,
    Bells2,
    KeyRing,
    Sink,
    Cans,
    Gong,
    Bong,
    Marimba,
    Fight,
    Tabla,
    Tabla2,
    Strings,
    OldClock,
    Crystal,
    Ride,
    Ride2,
    Crash,
    Vibes,
    Flute,
    Fifths,
    Kalimba,
};

Patch make_ripplerx_program(RipplerXProgram program) noexcept;
const char* ripplerx_program_name(RipplerXProgram program) noexcept;

} // namespace brk::modal
