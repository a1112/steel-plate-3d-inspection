cmake_minimum_required(VERSION 3.16)

project(steel_capture_qt_terminal LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

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
set(CAPTURE_SDK_DLL "${CAPTURE_SDK_ROOT}/${CAPTURE_SDK_ARCH}/dll/nvt_lvm_sdk.dll")

if(NOT CMAKE_PREFIX_PATH AND EXISTS "C:/Qt")
  if(MSVC)
    file(GLOB STEEL_QT_PREFIX_CANDIDATES "C:/Qt/*/msvc*_64")
  else()
    file(GLOB STEEL_QT_PREFIX_CANDIDATES "C:/Qt/*/mingw_64")
  endif()
  list(APPEND CMAKE_PREFIX_PATH ${STEEL_QT_PREFIX_CANDIDATES})
endif()

foreach(STEEL_QT_PREFIX IN LISTS CMAKE_PREFIX_PATH)
  string(TOLOWER "${STEEL_QT_PREFIX}" STEEL_QT_PREFIX_LOWER)
  if(MSVC AND STEEL_QT_PREFIX_LOWER MATCHES "mingw")
    message(FATAL_ERROR "MSVC builds cannot link the MinGW Qt kit at ${STEEL_QT_PREFIX}. Install a Qt msvc*_64 kit or pass -DCMAKE_PREFIX_PATH to that kit.")
  endif()
endforeach()

find_package(Qt6 COMPONENTS Widgets Network QUIET)
if(Qt6_FOUND)
  set(STEEL_QT_PACKAGE Qt6)
else()
  find_package(Qt5 COMPONENTS Widgets Network REQUIRED)
  set(STEEL_QT_PACKAGE Qt5)
endif()

set(STEEL_CAPTURE_BUILD_SERVICE OFF CACHE BOOL "Build the headless steel capture service executable" FORCE)
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../capture" "${CMAKE_CURRENT_BINARY_DIR}/capture-core")

add_executable(steel_capture_qt_terminal
  src/main.cpp
)

target_link_libraries(steel_capture_qt_terminal PRIVATE steel_capture_core ${STEEL_QT_PACKAGE}::Widgets ${STEEL_QT_PACKAGE}::Network)

if(MSVC)
  target_compile_options(steel_capture_qt_terminal PRIVATE /Zc:__cplusplus /permissive- /utf-8)
endif()

add_custom_command(TARGET steel_capture_qt_terminal POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CAPTURE_SDK_DLL}"
    "$<TARGET_FILE_DIR:steel_capture_qt_terminal>/nvt_lvm_sdk.dll"
)
