cmake_minimum_required(VERSION 3.12)

project(steel_capture_service LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CAPTURE_SDK_ROOT "C:/Program Files (x86)/Capture 6.7.0.4/LVM_NVT_SDK/LVM_C++_SDK" CACHE PATH "Capture LVM C++ SDK root")
set(CAPTURE_SDK_ARCH "x64" CACHE STRING "Capture SDK architecture")

set(CAPTURE_SDK_INCLUDE "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/Include")
set(CAPTURE_SDK_LIB "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/lib/nvt_lvm_sdk.lib")
set(CAPTURE_SDK_DLL "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/dll/nvt_lvm_sdk.dll")

add_executable(steel_capture_service
  src/main.cpp
)

target_include_directories(steel_capture_service PRIVATE "${CAPTURE_SDK_INCLUDE}")
target_link_libraries(steel_capture_service PRIVATE "${CAPTURE_SDK_LIB}" httpapi.lib)

target_compile_definitions(steel_capture_service PRIVATE
  _WIN32_WINNT=0x0A00
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)

add_custom_command(TARGET steel_capture_service POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CAPTURE_SDK_DLL}"
    "$<TARGET_FILE_DIR:steel_capture_service>/nvt_lvm_sdk.dll"
)
