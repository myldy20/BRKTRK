cmake_minimum_required(VERSION 3.20)
project(brk_modal LANGUAGES CXX)

option(BRK_MODAL_ENABLE_VECTOR "Enable architecture-specific four-lane modal kernels" ON)
set(BRK_MODAL_PROGRAM_BANK_INCLUDE "" CACHE FILEPATH
    "Optional generated RipplerX program-bank .inc used only by packaging tools")

add_library(brk_modal STATIC
    src/brk_modal.cpp
    src/brk_modal_quality.cpp
    src/brk_modal_auto_quality.cpp
)

target_include_directories(brk_modal PUBLIC include)
target_compile_features(brk_modal PUBLIC cxx_std_17)
if(BRK_MODAL_ENABLE_VECTOR)
    target_compile_definitions(brk_modal PRIVATE BRK_MODAL_ENABLE_VECTOR=1)
else()
    target_compile_definitions(brk_modal PRIVATE BRK_MODAL_ENABLE_VECTOR=0)
endif()

target_compile_options(brk_modal PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

add_executable(brk_modal_tests tests/test_brk_modal.cpp)
target_link_libraries(brk_modal_tests PRIVATE brk_modal)

add_executable(brk_modal_upstream_model_tests tests/test_upstream_models.cpp)
target_link_libraries(brk_modal_upstream_model_tests PRIVATE brk_modal)

add_executable(brk_modal_parameter_descriptor_tests tests/test_parameter_descriptors.cpp)
target_link_libraries(brk_modal_parameter_descriptor_tests PRIVATE brk_modal)

add_executable(brk_modal_state_v1_tests tests/test_state_v1.cpp)
target_link_libraries(brk_modal_state_v1_tests PRIVATE brk_modal)

add_executable(brk_modal_quality_profile_tests tests/test_quality_profiles.cpp)
target_link_libraries(brk_modal_quality_profile_tests PRIVATE brk_modal)

add_executable(brk_modal_auto_quality_tests tests/test_auto_quality.cpp)
target_link_libraries(brk_modal_auto_quality_tests PRIVATE brk_modal)

add_executable(brk_modal_kernel_tests tests/test_modal_kernels.cpp)
target_link_libraries(brk_modal_kernel_tests PRIVATE brk_modal)

add_executable(brk_modal_tail_sleep_tests tests/test_tail_sleep.cpp)
target_link_libraries(brk_modal_tail_sleep_tests PRIVATE brk_modal)

add_executable(brk_modal_held_tail_subnormal_tests tests/test_held_tail_subnormal.cpp)
target_link_libraries(brk_modal_held_tail_subnormal_tests PRIVATE brk_modal)
target_compile_options(brk_modal_held_tail_subnormal_tests PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

add_executable(brk_modal_tail_block_sample_equivalence_tests
    tests/test_tail_block_sample_equivalence.cpp)
target_link_libraries(brk_modal_tail_block_sample_equivalence_tests PRIVATE brk_modal)
target_compile_options(brk_modal_tail_block_sample_equivalence_tests PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

add_executable(brk_modal_p7_conformance_tests tests/test_p7_conformance.cpp)
target_link_libraries(brk_modal_p7_conformance_tests PRIVATE brk_modal)
target_compile_options(brk_modal_p7_conformance_tests PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

if(EMSCRIPTEN)
    # Legacy CLI correctness runners stay on the deterministic synchronous
    # filesystem path; production modules are built separately in abi/.
    target_link_options(brk_modal_kernel_tests PRIVATE "-sWASM_ASYNC_COMPILATION=0")
    target_link_options(brk_modal_tail_sleep_tests PRIVATE "-sWASM_ASYNC_COMPILATION=0")
    target_link_options(brk_modal_tail_block_sample_equivalence_tests PRIVATE
        "-sWASM_ASYNC_COMPILATION=0")
endif()

add_executable(brk_modal_render tools/render_demo.cpp)
target_link_libraries(brk_modal_render PRIVATE brk_modal)

add_executable(brk_modal_parity tools/render_parity.cpp)
target_link_libraries(brk_modal_parity PRIVATE brk_modal)

add_executable(brk_modal_musicality tools/render_musicality.cpp)
target_link_libraries(brk_modal_musicality PRIVATE brk_modal)

add_executable(brk_modal_lifecycle tools/render_lifecycle.cpp)
target_link_libraries(brk_modal_lifecycle PRIVATE brk_modal)

add_executable(brk_modal_upstream_models_render tools/render_upstream_models.cpp)
target_link_libraries(brk_modal_upstream_models_render PRIVATE brk_modal)

add_executable(brk_modal_parameter_snapshot tools/write_parameter_snapshot.cpp)
target_link_libraries(brk_modal_parameter_snapshot PRIVATE brk_modal)

add_executable(brk_modal_p47b_kernel_benchmark tools/benchmark_p47b_kernels.cpp)
target_link_libraries(brk_modal_p47b_kernel_benchmark PRIVATE brk_modal)

add_executable(brk_modal_p47b_kernel_parity tools/render_p47b_kernel_parity.cpp)
target_link_libraries(brk_modal_p47b_kernel_parity PRIVATE brk_modal)

add_executable(brk_modal_p47c_tail_benchmark tools/benchmark_p47c_tail_sleep.cpp)
target_link_libraries(brk_modal_p47c_tail_benchmark PRIVATE brk_modal)

add_executable(brk_modal_p47c_tail_render tools/render_p47c_tail_sleep.cpp)
target_link_libraries(brk_modal_p47c_tail_render PRIVATE brk_modal)

add_executable(brk_modal_held_tail_cost_benchmark tools/benchmark_held_tail_cost.cpp)
target_link_libraries(brk_modal_held_tail_cost_benchmark PRIVATE brk_modal)
target_compile_features(brk_modal_held_tail_cost_benchmark PRIVATE cxx_std_17)
target_compile_options(brk_modal_held_tail_cost_benchmark PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)
if(EMSCRIPTEN)
    target_link_options(brk_modal_held_tail_cost_benchmark PRIVATE
        "-sWASM_ASYNC_COMPILATION=0"
        "-sENVIRONMENT=node"
    )
endif()

add_executable(brk_modal_p9e_exact_kernel_benchmark tools/benchmark_p9e_exact_kernel.cpp)
target_link_libraries(brk_modal_p9e_exact_kernel_benchmark PRIVATE brk_modal)
target_compile_features(brk_modal_p9e_exact_kernel_benchmark PRIVATE cxx_std_17)
target_compile_options(brk_modal_p9e_exact_kernel_benchmark PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

add_executable(brk_modal_live_decay_tests tests/test_live_decay_reconfigure.cpp)
target_link_libraries(brk_modal_live_decay_tests PRIVATE brk_modal)
target_compile_options(brk_modal_live_decay_tests PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

add_executable(brk_modal_p9e_decay_ramp_benchmark tools/benchmark_p9e_decay_ramp.cpp)
target_link_libraries(brk_modal_p9e_decay_ramp_benchmark PRIVATE brk_modal)
target_compile_options(brk_modal_p9e_decay_ramp_benchmark PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

add_executable(brk_modal_live_performance_tests tests/test_live_performance_reconfigure.cpp)
target_link_libraries(brk_modal_live_performance_tests PRIVATE brk_modal)
target_compile_options(brk_modal_live_performance_tests PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

add_executable(brk_modal_p9e_live_control_benchmark tools/benchmark_p9e_live_controls.cpp)
target_link_libraries(brk_modal_p9e_live_control_benchmark PRIVATE brk_modal)
target_compile_options(brk_modal_p9e_live_control_benchmark PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

add_executable(brk_modal_p47d_quality_probe tools/benchmark_p47d_auto_quality.cpp)
target_link_libraries(brk_modal_p47d_quality_probe PRIVATE brk_modal)

add_executable(brk_modal_p8a_quality_benchmark tools/benchmark_p8a_quality.cpp)
target_link_libraries(brk_modal_p8a_quality_benchmark PRIVATE brk_modal)
target_compile_features(brk_modal_p8a_quality_benchmark PRIVATE cxx_std_17)
target_compile_options(brk_modal_p8a_quality_benchmark PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

# P6/P7 factory packaging is intentionally opt-in. The normal engine build
# remains network-independent and does not link the 28-program Reference bank.
# CI/package builds generate the .inc from the pinned RipplerX source, then pass
# its absolute path through BRK_MODAL_PROGRAM_BANK_INCLUDE.
if(BRK_MODAL_PROGRAM_BANK_INCLUDE)
    if(NOT EXISTS "${BRK_MODAL_PROGRAM_BANK_INCLUDE}")
        message(FATAL_ERROR "BRK_MODAL_PROGRAM_BANK_INCLUDE does not exist: ${BRK_MODAL_PROGRAM_BANK_INCLUDE}")
    endif()
    add_executable(brk_modal_p6_preset_pack tools/write_p6_preset_pack.cpp)
    target_link_libraries(brk_modal_p6_preset_pack PRIVATE brk_modal)
    target_compile_features(brk_modal_p6_preset_pack PRIVATE cxx_std_17)
    target_compile_options(brk_modal_p6_preset_pack PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )
    target_compile_definitions(brk_modal_p6_preset_pack PRIVATE
        BRK_MODAL_PROGRAM_BANK_INCLUDE="${BRK_MODAL_PROGRAM_BANK_INCLUDE}"
    )

    add_executable(brk_modal_reference_headroom_programs_test tests/test_reference_headroom_programs.cpp)
    target_link_libraries(brk_modal_reference_headroom_programs_test PRIVATE brk_modal)
    target_compile_features(brk_modal_reference_headroom_programs_test PRIVATE cxx_std_17)
    target_compile_options(brk_modal_reference_headroom_programs_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )
    target_compile_definitions(brk_modal_reference_headroom_programs_test PRIVATE
        BRK_MODAL_PROGRAM_BANK_INCLUDE="${BRK_MODAL_PROGRAM_BANK_INCLUDE}"
    )

    add_executable(brk_modal_p7_audition_pack tools/render_p7_audition_pack.cpp)
    target_link_libraries(brk_modal_p7_audition_pack PRIVATE brk_modal)
    target_compile_features(brk_modal_p7_audition_pack PRIVATE cxx_std_17)
    target_compile_options(brk_modal_p7_audition_pack PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )
    target_compile_definitions(brk_modal_p7_audition_pack PRIVATE
        BRK_MODAL_PROGRAM_BANK_INCLUDE="${BRK_MODAL_PROGRAM_BANK_INCLUDE}"
    )
endif()

include(CTest)
if(BUILD_TESTING)
    add_test(NAME brk_modal_tests COMMAND brk_modal_tests)
    add_test(NAME brk_modal_upstream_model_tests COMMAND brk_modal_upstream_model_tests)
    add_test(NAME brk_modal_parameter_descriptor_tests COMMAND brk_modal_parameter_descriptor_tests)
    add_test(NAME brk_modal_state_v1_tests COMMAND brk_modal_state_v1_tests)
    add_test(NAME brk_modal_quality_profile_tests COMMAND brk_modal_quality_profile_tests)
    add_test(NAME brk_modal_auto_quality_tests COMMAND brk_modal_auto_quality_tests)
    add_test(NAME brk_modal_kernel_tests COMMAND brk_modal_kernel_tests)
    add_test(NAME brk_modal_tail_sleep_tests COMMAND brk_modal_tail_sleep_tests)
    add_test(NAME brk_modal_held_tail_subnormal_tests COMMAND brk_modal_held_tail_subnormal_tests)
    add_test(NAME brk_modal_tail_block_sample_equivalence_tests
        COMMAND brk_modal_tail_block_sample_equivalence_tests)
    add_test(NAME brk_modal_p7_conformance_tests COMMAND brk_modal_p7_conformance_tests)
    add_test(NAME brk_modal_live_decay_tests COMMAND brk_modal_live_decay_tests)
    add_test(NAME brk_modal_live_performance_tests COMMAND brk_modal_live_performance_tests)
    add_test(
        NAME brk_modal_parity_smoke
        COMMAND brk_modal_parity ${CMAKE_CURRENT_BINARY_DIR}/parity-smoke --smoke
    )
    if(TARGET brk_modal_p6_preset_pack)
        add_test(
            NAME brk_modal_p6_preset_pack
            COMMAND brk_modal_p6_preset_pack ${CMAKE_CURRENT_BINARY_DIR}/p6-preset-pack-test
        )
        add_test(
            NAME brk_modal_reference_headroom_programs_test
            COMMAND brk_modal_reference_headroom_programs_test
        )
    endif()
    find_package(Python3 COMPONENTS Interpreter)
    if(Python3_Interpreter_FOUND)
        add_test(
            NAME brk_modal_upstream_preset_import
            COMMAND ${Python3_EXECUTABLE}
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_upstream_import.py
                ${CMAKE_CURRENT_SOURCE_DIR}/tools/import_ripplerx_presets.py
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/upstream-fixture
        )
        add_test(
            NAME brk_modal_p47a_noise_plan
            COMMAND ${Python3_EXECUTABLE}
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_p47a_noise_plan.py
                ${CMAKE_CURRENT_SOURCE_DIR}/tools/generate_p47a_noise_plan.py
        )
    endif()
endif()
