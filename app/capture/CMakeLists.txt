cmake_minimum_required(VERSION 3.12)

project(steel_capture_service LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
option(STEEL_CAPTURE_BUILD_SERVICE "Build the headless steel capture service executable" ON)

set(CAPTURE_SDK_ROOT "C:/Program Files (x86)/Capture 6.7.0.4/LVM_NVT_SDK/LVM_C++_SDK" CACHE PATH "Capture LVM C++ SDK root")
set(CAPTURE_SDK_ARCH "x64" CACHE STRING "Capture SDK architecture")

set(CAPTURE_SDK_INCLUDE "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/Include")
set(CAPTURE_SDK_LIB "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/lib/nvt_lvm_sdk.lib")
set(CAPTURE_SDK_DLL "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/dll/nvt_lvm_sdk.dll")

add_library(steel_capture_core STATIC
  src/capture_service_app.cpp
)

target_include_directories(steel_capture_core PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CAPTURE_SDK_INCLUDE}"
)
target_link_libraries(steel_capture_core PUBLIC "${CAPTURE_SDK_LIB}" httpapi.lib ws2_32.lib)

target_compile_definitions(steel_capture_core PUBLIC
  _WIN32_WINNT=0x0A00
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)

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
