cmake_minimum_required(VERSION 3.22.1)
project(brk_ripplerx_headless LANGUAGES CXX)

if(NOT DEFINED RIPPLERX_ROOT)
    message(FATAL_ERROR "RIPPLERX_ROOT must point to a RipplerX 1.5.18 checkout")
endif()

get_filename_component(RIPPLERX_ROOT "${RIPPLERX_ROOT}" ABSOLUTE)
if(NOT EXISTS "${RIPPLERX_ROOT}/CMakeLists.txt")
    message(FATAL_ERROR "RIPPLERX_ROOT does not contain CMakeLists.txt")
endif()

set(BUILD_STANDALONE OFF CACHE BOOL "Do not build the upstream standalone wrapper" FORCE)
add_subdirectory("${RIPPLERX_ROOT}" "${CMAKE_CURRENT_BINARY_DIR}/ripplerx")

# RipplerX 1.5.18 adds all processor/DSP sources directly to the project target.
# The format-specific targets (VST3/LV2/AU) wrap this target; the headless tool
# links to the same real processor code without creating a plug-in binary.
if(NOT TARGET RipplerX)
    message(FATAL_ERROR "RipplerX target was not created by the pinned upstream project")
endif()

add_executable(brk_ripplerx_headless ripplerx_headless.cpp)
target_compile_features(brk_ripplerx_headless PRIVATE cxx_std_17)

# juce_generate_juce_header(), JUCE modules and juce_add_binary_data() outputs
# are private to the upstream targets. The headless consumer uses the generated
# aggregation header too, so expose all deterministic generated/include roots.
target_include_directories(brk_ripplerx_headless PRIVATE
    "${CMAKE_CURRENT_BINARY_DIR}/ripplerx/RipplerX_artefacts/JuceLibraryCode"
    "${CMAKE_CURRENT_BINARY_DIR}/ripplerx/juce_binarydata_RipplerX_res/JuceLibraryCode"
    "${RIPPLERX_ROOT}/libs/JUCE/modules"
)

target_link_libraries(brk_ripplerx_headless PRIVATE RipplerX)
target_compile_options(brk_ripplerx_headless PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

# juce_audio_processors already declares createPluginFilter(), while the
# runner repeats the declaration to make the factory dependency explicit.
# Apply this one exception at source scope so it is ordered after JUCE's public
# recommended-warning flags; every other warning remains fatal.
set_source_files_properties(ripplerx_headless.cpp PROPERTIES
    COMPILE_OPTIONS "$<$<CXX_COMPILER_ID:GNU,Clang>:-Wno-error=redundant-decls;-Wno-redundant-decls>"
)
