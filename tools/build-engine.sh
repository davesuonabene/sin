#!/usr/bin/env bash
# Build native libsin_dsp (.dylib on macOS, .so on Linux) with zero external build tools required.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$ROOT_DIR/engine"
BIN_DIR="$ENGINE_DIR/bin"
mkdir -p "$BIN_DIR"

CXX="${CXX:-clang++}"
if ! command -v "$CXX" >/dev/null 2>&1; then
  CXX="g++"
fi
if ! command -v "$CXX" >/dev/null 2>&1; then
  echo "No C++ compiler found (install Xcode Command Line Tools on macOS: xcode-select --install)." >&2
  exit 1
fi

UNAME_S="$(uname -s)"
if [[ "$UNAME_S" == "Darwin" ]]; then
  OUT_LIB="$BIN_DIR/libsin_dsp.dylib"
  echo "Building $OUT_LIB using $CXX (CoreAudio)..."
  "$CXX" -O3 -std=c++20 -fPIC -dynamiclib \
    -DSIN_DSP_BUILD \
    -I"$ENGINE_DIR/include" -I"$ENGINE_DIR/src" -I"$ENGINE_DIR/third_party" -I"$ROOT_DIR/dsp_modules/include" \
    "$ENGINE_DIR/src/miniaudio_impl.cpp" "$ENGINE_DIR/src/sin_engine.cpp" \
    -framework CoreAudio -framework AudioToolbox -framework CoreFoundation \
    -lpthread -ldl -lm \
    -o "$OUT_LIB"
else
  OUT_LIB="$BIN_DIR/libsin_dsp.so"
  echo "Building $OUT_LIB using $CXX..."
  "$CXX" -O3 -std=c++20 -fPIC -shared \
    -DSIN_DSP_BUILD \
    -I"$ENGINE_DIR/include" -I"$ENGINE_DIR/src" -I"$ENGINE_DIR/third_party" -I"$ROOT_DIR/dsp_modules/include" \
    "$ENGINE_DIR/src/miniaudio_impl.cpp" "$ENGINE_DIR/src/sin_engine.cpp" \
    -lpthread -ldl -lm \
    -o "$OUT_LIB"
fi

echo "Built: $OUT_LIB"

if [[ "${1:-}" == "--test" ]]; then
  TEST_BIN="$BIN_DIR/sin_dsp_tests"
  if [[ "$UNAME_S" == "Darwin" ]]; then
    "$CXX" -O2 -std=c++20 -DSIN_DSP_STATIC \
      -I"$ENGINE_DIR/include" -I"$ENGINE_DIR/src" -I"$ENGINE_DIR/third_party" -I"$ROOT_DIR/dsp_modules/include" \
      "$ENGINE_DIR/tests/test_sin_dsp.cpp" "$ENGINE_DIR/src/miniaudio_impl.cpp" "$ENGINE_DIR/src/sin_engine.cpp" \
      -framework CoreAudio -framework AudioToolbox -framework CoreFoundation \
      -lpthread -ldl -lm -o "$TEST_BIN"
  else
    "$CXX" -O2 -std=c++20 -DSIN_DSP_STATIC \
      -I"$ENGINE_DIR/include" -I"$ENGINE_DIR/src" -I"$ENGINE_DIR/third_party" -I"$ROOT_DIR/dsp_modules/include" \
      "$ENGINE_DIR/tests/test_sin_dsp.cpp" "$ENGINE_DIR/src/miniaudio_impl.cpp" "$ENGINE_DIR/src/sin_engine.cpp" \
      -lpthread -ldl -lm -o "$TEST_BIN"
  fi
  "$TEST_BIN"
fi
