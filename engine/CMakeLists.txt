cmake_minimum_required(VERSION 3.20)
project(sin_dsp LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Shared core object library (compiles miniaudio once)
add_library(sin_dsp_objs OBJECT
    src/miniaudio_impl.cpp
    src/sin_engine.cpp
)
target_include_directories(sin_dsp_objs PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)
set_target_properties(sin_dsp_objs PROPERTIES POSITION_INDEPENDENT_CODE ON)

if(MSVC)
    target_compile_options(sin_dsp_objs PRIVATE /W3 /O2 /EHsc /utf-8)
    target_compile_definitions(sin_dsp_objs PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
else()
    target_compile_options(sin_dsp_objs PRIVATE -O3 -Wall -Wextra -Wno-unused-function -Wno-missing-field-initializers)
endif()

# Shared library loaded in-process by Python (sin_dsp.dll / libsin_dsp.dylib / libsin_dsp.so)
add_library(sin_dsp SHARED $<TARGET_OBJECTS:sin_dsp_objs>)
target_compile_definitions(sin_dsp_objs PRIVATE SIN_DSP_BUILD)
target_include_directories(sin_dsp PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

set_target_properties(sin_dsp PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/build/lib"
)
foreach(CFG DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
    set_target_properties(sin_dsp PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY_${CFG} "${CMAKE_CURRENT_SOURCE_DIR}/bin"
        LIBRARY_OUTPUT_DIRECTORY_${CFG} "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    )
endforeach()

if(APPLE)
    target_link_libraries(sin_dsp PRIVATE
        "-framework CoreAudio"
        "-framework AudioToolbox"
        "-framework CoreFoundation"
        pthread dl m
    )
elseif(UNIX)
    target_link_libraries(sin_dsp PRIVATE pthread dl m)
endif()

# Standalone C++ test executable (links static object directly so operator new trap intercepts engine allocations)
enable_testing()
add_executable(sin_dsp_tests
    tests/test_sin_dsp.cpp
    src/miniaudio_impl.cpp
    src/sin_engine.cpp
)
target_compile_definitions(sin_dsp_tests PRIVATE SIN_DSP_STATIC _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
target_include_directories(sin_dsp_tests PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)
if(MSVC)
    target_compile_options(sin_dsp_tests PRIVATE /W3 /O2 /EHsc /utf-8)
else()
    target_compile_options(sin_dsp_tests PRIVATE -O2 -Wall -Wextra -Wno-unused-function)
endif()
if(APPLE)
    target_link_libraries(sin_dsp_tests PRIVATE
        "-framework CoreAudio"
        "-framework AudioToolbox"
        "-framework CoreFoundation"
        pthread dl m
    )
elseif(UNIX)
    target_link_libraries(sin_dsp_tests PRIVATE pthread dl m)
endif()

add_test(NAME sin_dsp_core_tests COMMAND sin_dsp_tests)
