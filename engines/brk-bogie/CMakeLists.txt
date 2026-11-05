cmake_minimum_required(VERSION 3.20)
project(brk_bogie_p1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CHOO_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/third_party/choochoorack)
set(BRK_BOGIE_ABI_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/../../abi/include")

add_library(choo_bogie_dsp STATIC ${CHOO_ROOT}/bogie_core.cpp)
target_include_directories(choo_bogie_dsp PUBLIC ${CHOO_ROOT})

add_library(brk_bogie_core STATIC src/bogie_engine.cpp)
target_include_directories(brk_bogie_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(brk_bogie_core PUBLIC choo_bogie_dsp)

add_library(brk_bogie_module STATIC module/brk_bogie_module.cpp)
target_link_libraries(brk_bogie_module PUBLIC brk_bogie_core)
target_include_directories(brk_bogie_module PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/module
  ${BRK_BOGIE_ABI_INCLUDE})

add_executable(brk_bogie_upstream_tests ${CHOO_ROOT}/bogie_core_upstream_test.cpp)
target_link_libraries(brk_bogie_upstream_tests PRIVATE choo_bogie_dsp)
# The upstream test uses assert(); keep those checks active in Release CI.
if(MSVC)
  target_compile_options(brk_bogie_upstream_tests PRIVATE /UNDEBUG)
else()
  target_compile_options(brk_bogie_upstream_tests PRIVATE -UNDEBUG)
endif()

add_executable(brk_bogie_p1_core_tests tests/test_bogie.cpp)
target_link_libraries(brk_bogie_p1_core_tests PRIVATE brk_bogie_core)

add_executable(brk_bogie_p1_abi_tests tests/test_bogie_abi.cpp)
target_link_libraries(brk_bogie_p1_abi_tests PRIVATE brk_bogie_module)
target_include_directories(brk_bogie_p1_abi_tests PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/module
  ${BRK_BOGIE_ABI_INCLUDE})

set(BRK_BOGIE_STRICT_TARGETS
  brk_bogie_core
  brk_bogie_module
  brk_bogie_p1_core_tests
  brk_bogie_p1_abi_tests)

if(MSVC)
  foreach(target IN LISTS BRK_BOGIE_STRICT_TARGETS)
    target_compile_options(${target} PRIVATE /W4 /WX)
  endforeach()
else()
  foreach(target IN LISTS BRK_BOGIE_STRICT_TARGETS)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endforeach()
endif()

find_package(Python3 COMPONENTS Interpreter REQUIRED)

if(EMSCRIPTEN)
  set(BRK_BOGIE_WASM_EXPORTS
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPF32']"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_brk_abi_version','_brk_module_descriptor','_brk_engine_descriptor','_brk_parameter_descriptor','_brk_instance_create','_brk_instance_prepare','_brk_instance_activate','_brk_instance_deactivate','_brk_instance_reset','_brk_instance_destroy','_brk_instance_process','_brk_instance_state_size','_brk_instance_state_write','_brk_instance_state_read']")

  add_executable(brk_bogie_wasm
    module/brk_bogie_module.cpp
    src/bogie_engine.cpp
    ${CHOO_ROOT}/bogie_core.cpp)
  target_include_directories(brk_bogie_wasm PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/module
    ${BRK_BOGIE_ABI_INCLUDE}
    ${CHOO_ROOT})
  target_compile_options(brk_bogie_wasm PRIVATE -Wall -Wextra -Wpedantic -Werror)
  target_link_options(brk_bogie_wasm PRIVATE
    --no-entry
    "-sMODULARIZE=1"
    "-sENVIRONMENT=web,worker,node"
    "-sFILESYSTEM=0"
    "-sALLOW_MEMORY_GROWTH=0"
    "-sINITIAL_MEMORY=4194304"
    "-sTOTAL_STACK=524288"
    ${BRK_BOGIE_WASM_EXPORTS})
  set_target_properties(brk_bogie_wasm PROPERTIES
    OUTPUT_NAME "brk_bogie_module"
    SUFFIX ".js")

  add_executable(brk_bogie_worklet_module
    module/brk_bogie_module.cpp
    src/bogie_engine.cpp
    ${CHOO_ROOT}/bogie_core.cpp)
  target_include_directories(brk_bogie_worklet_module PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/module
    ${BRK_BOGIE_ABI_INCLUDE}
    ${CHOO_ROOT})
  target_compile_options(brk_bogie_worklet_module PRIVATE -Wall -Wextra -Wpedantic -Werror)
  target_link_options(brk_bogie_worklet_module PRIVATE
    --no-entry
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createBrkBogieModule"
    "-sENVIRONMENT=worklet"
    "-sSINGLE_FILE=1"
    "-sWASM_ASYNC_COMPILATION=0"
    "-sFILESYSTEM=0"
    "-sALLOW_MEMORY_GROWTH=0"
    "-sINITIAL_MEMORY=4194304"
    "-sTOTAL_STACK=524288"
    ${BRK_BOGIE_WASM_EXPORTS})
  set_target_properties(brk_bogie_worklet_module PROPERTIES
    OUTPUT_NAME "brk_bogie_worklet_module"
    SUFFIX ".mjs")
endif()

enable_testing()
add_test(NAME brk_bogie_upstream_tests COMMAND brk_bogie_upstream_tests)
add_test(NAME brk_bogie_p1_core_tests COMMAND brk_bogie_p1_core_tests)
add_test(NAME brk_bogie_p1_abi_tests COMMAND brk_bogie_p1_abi_tests)
add_test(
  NAME brk_bogie_ui_contract
  COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_ui_contract.py)
