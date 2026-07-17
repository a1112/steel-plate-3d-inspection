cmake_minimum_required(VERSION 3.12)

project(steel_capture_service LANGUAGES CXX)

include(CTest)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
option(STEEL_CAPTURE_BUILD_SERVICE "Build the headless steel capture service executable" ON)
option(STEEL_CAPTURE_BUILD_CORE "Build the vendor-SDK-backed capture core" ON)
option(STEEL_CAPTURE_BUILD_SUPERVISOR "Build the SDK-independent Windows runtime supervisor" ON)

if(STEEL_CAPTURE_BUILD_SERVICE AND NOT STEEL_CAPTURE_BUILD_CORE)
  message(FATAL_ERROR "STEEL_CAPTURE_BUILD_SERVICE requires STEEL_CAPTURE_BUILD_CORE")
endif()

set(STEEL_CAPTURE_SDK_DEFAULT_ROOT "C:/Program Files (x86)/Capture 6.7.0.4/LVM_NVT_SDK/LVM_C++_SDK")
foreach(STEEL_CAPTURE_SDK_CANDIDATE
    "C:/Program Files (x86)/Capture 6.7.0.8/LVM_NVT_SDK/LVM_C++_SDK"
    "C:/Program Files (x86)/Capture 6.7.0.4/LVM_NVT_SDK/LVM_C++_SDK")
  if(EXISTS "${STEEL_CAPTURE_SDK_CANDIDATE}/x64/Include/lvm_sdk.h")
    set(STEEL_CAPTURE_SDK_DEFAULT_ROOT "${STEEL_CAPTURE_SDK_CANDIDATE}")
    break()
  endif()
endforeach()
set(CAPTURE_SDK_ROOT "${STEEL_CAPTURE_SDK_DEFAULT_ROOT}" CACHE PATH "Capture LVM C++ SDK root")
set(CAPTURE_SDK_ARCH "x64" CACHE STRING "Capture SDK architecture")

set(CAPTURE_SDK_INCLUDE "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/Include")
set(CAPTURE_SDK_LIB "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/lib/nvt_lvm_sdk.lib")
set(CAPTURE_SDK_DLL "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/dll/nvt_lvm_sdk.dll")

if(STEEL_CAPTURE_BUILD_CORE)
  add_library(steel_capture_core STATIC
    src/capture_service_app.cpp
    src/calibration_contract.h
    src/capture_concurrency_policy.h
    src/capture_health_policy.h
    src/capture_path_policy.h
    src/owned_worker_registry.h
    src/storage_thread_pool.h
  )

  target_include_directories(steel_capture_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CAPTURE_SDK_INCLUDE}"
  )
  target_link_libraries(steel_capture_core PUBLIC "${CAPTURE_SDK_LIB}" httpapi.lib ws2_32.lib bcrypt.lib)

  target_compile_definitions(steel_capture_core PUBLIC
    _WIN32_WINNT=0x0A00
    WIN32_LEAN_AND_MEAN
    NOMINMAX
  )
endif()

if(STEEL_CAPTURE_BUILD_SERVICE)
  add_executable(steel_capture_service
    src/steel_capture_service_main.cpp
  )

  target_link_libraries(steel_capture_service PRIVATE steel_capture_core)

  add_custom_command(TARGET steel_capture_service POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${CAPTURE_SDK_DLL}"
      "$<TARGET_FILE_DIR:steel_capture_service>/nvt_lvm_sdk.dll"
  )

endif()

if(STEEL_CAPTURE_BUILD_SUPERVISOR)
  add_executable(steel_runtime_supervisor
    src/steel_runtime_supervisor_main.cpp
    src/runtime_supervisor_recovery_policy.h
  )
  target_compile_definitions(steel_runtime_supervisor PRIVATE
    _WIN32_WINNT=0x0A00
    WIN32_LEAN_AND_MEAN
    NOMINMAX
  )
  target_link_libraries(steel_runtime_supervisor PRIVATE advapi32.lib ws2_32.lib)
endif()

if(BUILD_TESTING)
  add_executable(steel_capture_storage_thread_pool_test
    tests/storage_thread_pool_test.cpp
  )
  target_include_directories(steel_capture_storage_thread_pool_test PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  add_test(
    NAME steel_capture_storage_thread_pool_test
    COMMAND steel_capture_storage_thread_pool_test
  )

  add_executable(steel_capture_owned_worker_registry_test
    tests/owned_worker_registry_test.cpp
  )
  target_include_directories(steel_capture_owned_worker_registry_test PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  add_test(
    NAME steel_capture_owned_worker_registry_test
    COMMAND steel_capture_owned_worker_registry_test
  )

  add_executable(steel_capture_path_policy_test
    tests/capture_path_policy_test.cpp
  )
  target_include_directories(steel_capture_path_policy_test PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  add_test(
    NAME steel_capture_path_policy_test
    COMMAND steel_capture_path_policy_test
  )

  add_executable(steel_capture_calibration_contract_test
    tests/calibration_contract_test.cpp
  )
  target_include_directories(steel_capture_calibration_contract_test PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  add_test(
    NAME steel_capture_calibration_contract_test
    COMMAND steel_capture_calibration_contract_test
  )

  add_executable(steel_capture_health_policy_test
    tests/capture_health_policy_test.cpp
  )
  target_include_directories(steel_capture_health_policy_test PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  add_test(
    NAME steel_capture_health_policy_test
    COMMAND steel_capture_health_policy_test
  )

  add_executable(steel_capture_concurrency_policy_test
    tests/capture_concurrency_policy_test.cpp
  )
  target_include_directories(steel_capture_concurrency_policy_test PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  add_test(
    NAME steel_capture_concurrency_policy_test
    COMMAND steel_capture_concurrency_policy_test
  )

  add_executable(steel_runtime_supervisor_recovery_policy_test
    tests/runtime_supervisor_recovery_policy_test.cpp
  )
  target_include_directories(steel_runtime_supervisor_recovery_policy_test PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
  )
  add_test(
    NAME steel_runtime_supervisor_recovery_policy_test
    COMMAND steel_runtime_supervisor_recovery_policy_test
  )

  if(WIN32)
    find_package(Python3 COMPONENTS Interpreter QUIET)
    if(Python3_Interpreter_FOUND)
      if(STEEL_CAPTURE_BUILD_SERVICE)
        add_test(
          NAME steel_capture_frame_pipeline_test
          COMMAND "${Python3_EXECUTABLE}"
                  "${CMAKE_CURRENT_SOURCE_DIR}/tests/frame_pipeline_test.py"
                  --exe "$<TARGET_FILE:steel_capture_service>"
        )
        set_tests_properties(steel_capture_frame_pipeline_test PROPERTIES TIMEOUT 60)
      endif()

      add_test(
        NAME steel_capture_calibration_target_detection_test
        COMMAND "${Python3_EXECUTABLE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/calibration_target_detection_test.py"
      )
      set_tests_properties(steel_capture_calibration_target_detection_test PROPERTIES TIMEOUT 30)
    endif()
  endif()
endif()
