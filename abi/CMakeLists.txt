cmake_minimum_required(VERSION 3.20)
project(brk_synth_abi LANGUAGES C CXX)

set(BRK_MODAL_ENGINE_SOURCES
    ../engines/brk-modal/src/brk_modal.cpp
    ../engines/brk-modal/src/brk_modal_quality.cpp
    ../engines/brk-modal/src/brk_modal_auto_quality.cpp
)
set(BRK_MODAL_MODULE_SOURCES
    native/brk_modal_module.cpp
    native/brk_modal_host_quality.cpp
    native/brk_modal_runtime_policy.cpp
    ${BRK_MODAL_ENGINE_SOURCES}
)

option(BRK_MODAL_BUILD_LEGACY_WORKLET
    "Build the original private host's AudioWorklet bundles (requires host/browser sources)" OFF)

if(EMSCRIPTEN)
    set(BRK_MODAL_WASM_EXPORTS
        "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPF32']"
        "-sEXPORTED_FUNCTIONS=['_malloc','_free','_brk_abi_version','_brk_module_descriptor','_brk_engine_descriptor','_brk_parameter_descriptor','_brk_instance_create','_brk_instance_prepare','_brk_instance_activate','_brk_instance_deactivate','_brk_instance_reset','_brk_instance_destroy','_brk_instance_process','_brk_instance_state_size','_brk_instance_state_write','_brk_instance_state_read','_brk_runtime_policy_set_u32','_brk_runtime_policy_get_u32','_brk_modal_quality_source_sync','_brk_modal_quality_source_set_parameter','_brk_modal_quality_apply','_brk_modal_quality_profile','_brk_modal_quality_auto_reset','_brk_modal_quality_auto_observe','_brk_modal_runtime_kernel_set','_brk_modal_runtime_kernel_requested','_brk_modal_runtime_kernel_active','_brk_modal_runtime_vector_available','_brk_modal_runtime_reference_output_mode_set','_brk_modal_runtime_reference_output_mode']"
    )

    add_executable(brk_modal_wasm ${BRK_MODAL_MODULE_SOURCES})
    target_include_directories(brk_modal_wasm PRIVATE
        include
        native
        ${CMAKE_CURRENT_SOURCE_DIR}/../engines/brk-modal/include
    )
    target_compile_features(brk_modal_wasm PRIVATE cxx_std_17)
    target_compile_options(brk_modal_wasm PRIVATE -Wall -Wextra -Wpedantic -Werror)
    target_link_options(brk_modal_wasm PRIVATE
        --no-entry
        "-sMODULARIZE=1"
        "-sENVIRONMENT=web,worker,node"
        "-sFILESYSTEM=0"
        "-sALLOW_MEMORY_GROWTH=0"
        "-sINITIAL_MEMORY=33554432"
        "-sTOTAL_STACK=1048576"
        ${BRK_MODAL_WASM_EXPORTS}
    )
    set_target_properties(brk_modal_wasm PROPERTIES
        OUTPUT_NAME "brk_modal_module"
        SUFFIX ".js"
    )

    # The independent BRKTRK ABI factory above produces direct JS + WASM
    # for the public host. The legacy private-host worklet generator below
    # imports host/browser/build_worklet_post.py, which does not belong to
    # the GPL BRKTRK source tree. Keep it optional and disabled by default.
    if(BRK_MODAL_BUILD_LEGACY_WORKLET)
    # P5B+: directly loadable AudioWorklet modules. Emscripten inserts --post-js
    # inside its wrapper, so generate plain JS from the canonical browser host
    # sources instead of duplicating host logic. Wasm is embedded and
    # synchronously initialized before processor registration. No SAB/workers.
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(BRK_MODAL_WORKLET_POST_DIR "${CMAKE_BINARY_DIR}/p5b-generated")
    set(BRK_MODAL_WORKLET_POST_JS "${BRK_MODAL_WORKLET_POST_DIR}/brk_audio_worklet_post.js")
    file(MAKE_DIRECTORY "${BRK_MODAL_WORKLET_POST_DIR}")
    execute_process(
        COMMAND "${Python3_EXECUTABLE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/../host/browser/build_worklet_post.py"
                "${BRK_MODAL_WORKLET_POST_JS}"
        RESULT_VARIABLE BRK_MODAL_WORKLET_POST_RESULT
        OUTPUT_VARIABLE BRK_MODAL_WORKLET_POST_OUTPUT
        ERROR_VARIABLE BRK_MODAL_WORKLET_POST_ERROR
    )
    if(NOT BRK_MODAL_WORKLET_POST_RESULT EQUAL 0)
        message(FATAL_ERROR
            "Failed to generate AudioWorklet post-js: ${BRK_MODAL_WORKLET_POST_ERROR}"
        )
    endif()
    message(STATUS "${BRK_MODAL_WORKLET_POST_OUTPUT}")

    add_executable(brk_modal_worklet_wasm ${BRK_MODAL_MODULE_SOURCES})
    target_include_directories(brk_modal_worklet_wasm PRIVATE
        include
        native
        ${CMAKE_CURRENT_SOURCE_DIR}/../engines/brk-modal/include
    )
    target_compile_features(brk_modal_worklet_wasm PRIVATE cxx_std_17)
    target_compile_options(brk_modal_worklet_wasm PRIVATE -Wall -Wextra -Wpedantic -Werror)
    target_link_options(brk_modal_worklet_wasm PRIVATE
        --no-entry
        "--post-js=${BRK_MODAL_WORKLET_POST_JS}"
        "-sENVIRONMENT=worklet"
        "-sSINGLE_FILE=1"
        "-sWASM_ASYNC_COMPILATION=0"
        "-sFILESYSTEM=0"
        "-sALLOW_MEMORY_GROWTH=0"
        "-sINITIAL_MEMORY=33554432"
        "-sTOTAL_STACK=1048576"
        ${BRK_MODAL_WASM_EXPORTS}
    )
    set_target_properties(brk_modal_worklet_wasm PROPERTIES
        OUTPUT_NAME "brk_modal_worklet_module"
        SUFFIX ".mjs"
    )

    # P9E representative-device hardening: keep the scalar worklet as a real
    # compatibility fallback while building a second SIMD128 variant. The
    # browser chooses SIMD first and falls back to the scalar module if the
    # worklet cannot be loaded on an older runtime. Runtime kernel selection is
    # host-owned and remains outside frozen ABI/state.
    add_executable(brk_modal_worklet_wasm_simd ${BRK_MODAL_MODULE_SOURCES})
    target_include_directories(brk_modal_worklet_wasm_simd PRIVATE
        include
        native
        ${CMAKE_CURRENT_SOURCE_DIR}/../engines/brk-modal/include
    )
    target_compile_features(brk_modal_worklet_wasm_simd PRIVATE cxx_std_17)
    target_compile_options(brk_modal_worklet_wasm_simd PRIVATE
        -Wall -Wextra -Wpedantic -Werror -msimd128
    )
    target_link_options(brk_modal_worklet_wasm_simd PRIVATE
        -msimd128
        --no-entry
        "--post-js=${BRK_MODAL_WORKLET_POST_JS}"
        "-sENVIRONMENT=worklet"
        "-sSINGLE_FILE=1"
        "-sWASM_ASYNC_COMPILATION=0"
        "-sFILESYSTEM=0"
        "-sALLOW_MEMORY_GROWTH=0"
        "-sINITIAL_MEMORY=33554432"
        "-sTOTAL_STACK=1048576"
        ${BRK_MODAL_WASM_EXPORTS}
    )
    set_target_properties(brk_modal_worklet_wasm_simd PROPERTIES
        OUTPUT_NAME "brk_modal_worklet_module_simd"
        SUFFIX ".mjs"
    )
    endif() # BRK_MODAL_BUILD_LEGACY_WORKLET
else()
    add_executable(brk_abi_c_test tests/test_abi_c.c)
    target_include_directories(brk_abi_c_test PRIVATE include)
    target_compile_features(brk_abi_c_test PRIVATE c_std_11)
    target_compile_options(brk_abi_c_test PRIVATE
        $<$<C_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_abi_layout_test tests/test_abi_layout.cpp)
    target_include_directories(brk_abi_layout_test PRIVATE
        include
        ${CMAKE_CURRENT_SOURCE_DIR}/../engines/brk-modal/include
    )
    target_compile_features(brk_abi_layout_test PRIVATE cxx_std_17)
    target_compile_options(brk_abi_layout_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_asset_ext_layout_test tests/test_asset_ext_layout.cpp)
    target_include_directories(brk_asset_ext_layout_test PRIVATE include)
    target_compile_features(brk_asset_ext_layout_test PRIVATE cxx_std_17)
    target_compile_options(brk_asset_ext_layout_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_parameter_descriptor_fixture tests/write_parameter_descriptor_fixture.cpp)
    target_include_directories(brk_parameter_descriptor_fixture PRIVATE
        include
        ${CMAKE_CURRENT_SOURCE_DIR}/../engines/brk-modal/include
    )
    target_compile_features(brk_parameter_descriptor_fixture PRIVATE cxx_std_17)
    target_compile_options(brk_parameter_descriptor_fixture PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_native_event_executor_test
        tests/test_native_event_executor.cpp
        ${BRK_MODAL_ENGINE_SOURCES}
    )
    target_include_directories(brk_native_event_executor_test PRIVATE
        include
        native
        ${CMAKE_CURRENT_SOURCE_DIR}/../engines/brk-modal/include
    )
    target_compile_features(brk_native_event_executor_test PRIVATE cxx_std_17)
    target_compile_options(brk_native_event_executor_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_p8a_event_fuzz_test
        tests/test_p8a_event_fuzz.cpp
        ${BRK_MODAL_ENGINE_SOURCES}
    )
    target_include_directories(brk_p8a_event_fuzz_test PRIVATE
        include
        native
        ${CMAKE_CURRENT_SOURCE_DIR}/../engines/brk-modal/include
    )
    target_compile_features(brk_p8a_event_fuzz_test PRIVATE cxx_std_17)
    target_compile_options(brk_p8a_event_fuzz_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_library(brk_modal_module STATIC ${BRK_MODAL_MODULE_SOURCES})
    target_include_directories(brk_modal_module PUBLIC
        include
        native
        ${CMAKE_CURRENT_SOURCE_DIR}/../engines/brk-modal/include
    )
    target_compile_features(brk_modal_module PUBLIC cxx_std_17)
    target_compile_options(brk_modal_module PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_module_runtime_test
        tests/test_module_runtime.cpp
        tests/test_nothrow_allocation_bridge.cpp
    )
    target_link_libraries(brk_module_runtime_test PRIVATE brk_modal_module)
    target_compile_features(brk_module_runtime_test PRIVATE cxx_std_17)
    target_compile_options(brk_module_runtime_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_persistent_event_executor_properties_test
        tests/test_persistent_event_executor_properties.cpp
    )
    target_link_libraries(brk_persistent_event_executor_properties_test PRIVATE brk_modal_module)
    target_compile_features(brk_persistent_event_executor_properties_test PRIVATE cxx_std_17)
    target_compile_options(brk_persistent_event_executor_properties_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_persistent_ramp_cost_test
        tests/test_persistent_ramp_cost.cpp
    )
    target_link_libraries(brk_persistent_ramp_cost_test PRIVATE brk_modal_module)
    target_compile_features(brk_persistent_ramp_cost_test PRIVATE cxx_std_17)
    target_compile_options(brk_persistent_ramp_cost_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_event_free_block_fast_path_test
        tests/test_event_free_block_fast_path.cpp
    )
    target_link_libraries(brk_event_free_block_fast_path_test PRIVATE brk_modal_module)
    target_compile_features(brk_event_free_block_fast_path_test PRIVATE cxx_std_17)
    target_compile_options(brk_event_free_block_fast_path_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_modal_host_quality_test tests/test_modal_host_quality.cpp)
    target_link_libraries(brk_modal_host_quality_test PRIVATE brk_modal_module)
    target_compile_features(brk_modal_host_quality_test PRIVATE cxx_std_17)
    target_compile_options(brk_modal_host_quality_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_runtime_policy_extension_test tests/test_runtime_policy_extension.cpp)
    target_link_libraries(brk_runtime_policy_extension_test PRIVATE brk_modal_module)
    target_compile_features(brk_runtime_policy_extension_test PRIVATE cxx_std_17)
    target_compile_options(brk_runtime_policy_extension_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_p5c_track_host_test tests/test_p5c_track_host.cpp)
    target_link_libraries(brk_p5c_track_host_test PRIVATE brk_modal_module)
    target_compile_features(brk_p5c_track_host_test PRIVATE cxx_std_17)
    target_compile_options(brk_p5c_track_host_test PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    add_executable(brk_p4_factory_state_fixture tests/write_p4_factory_state.cpp)
    target_link_libraries(brk_p4_factory_state_fixture PRIVATE brk_modal_module)
    target_compile_features(brk_p4_factory_state_fixture PRIVATE cxx_std_17)
    target_compile_options(brk_p4_factory_state_fixture PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    )

    include(CTest)
    if(BUILD_TESTING)
        add_test(NAME brk_abi_c_test COMMAND brk_abi_c_test)
        add_test(NAME brk_abi_layout_test COMMAND brk_abi_layout_test)
        add_test(NAME brk_asset_ext_layout_test COMMAND brk_asset_ext_layout_test)
        add_test(NAME brk_native_event_executor_test COMMAND brk_native_event_executor_test)
        add_test(NAME brk_p8a_event_fuzz_test COMMAND brk_p8a_event_fuzz_test)
        add_test(NAME brk_module_runtime_test COMMAND brk_module_runtime_test)
        add_test(NAME brk_persistent_event_executor_properties_test COMMAND brk_persistent_event_executor_properties_test)
        add_test(NAME brk_persistent_ramp_cost_test COMMAND brk_persistent_ramp_cost_test)
        add_test(NAME brk_event_free_block_fast_path_test COMMAND brk_event_free_block_fast_path_test)
        add_test(NAME brk_modal_host_quality_test COMMAND brk_modal_host_quality_test)
        add_test(NAME brk_runtime_policy_extension_test COMMAND brk_runtime_policy_extension_test)
        add_test(NAME brk_p5c_track_host_test COMMAND brk_p5c_track_host_test)
    endif()
endif()
