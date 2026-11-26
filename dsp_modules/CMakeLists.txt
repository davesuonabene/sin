cmake_minimum_required(VERSION 3.20)
project(sin_fx_modules LANGUAGES CXX)

add_library(sin_fx_modules INTERFACE)
target_include_directories(sin_fx_modules INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_features(sin_fx_modules INTERFACE cxx_std_20)
