cmake_minimum_required(VERSION 3.20)

project(steel_inspection_backend LANGUAGES CXX)

add_executable(steel_inspection_backend
  src/main.cpp
)

target_compile_features(steel_inspection_backend PRIVATE cxx_std_17)
target_compile_options(steel_inspection_backend PRIVATE -Wall -Wextra -Wpedantic)
