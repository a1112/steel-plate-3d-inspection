cmake_minimum_required(VERSION 3.12)

project(steel_bar_surface_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(steel_bar_surface_core
  src/main.cpp
)

target_compile_definitions(steel_bar_surface_core PRIVATE
  _CRT_SECURE_NO_WARNINGS
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)
