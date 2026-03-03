#!/usr/bin/env bash
#
# Build libtropic for WebAssembly using Emscripten.
#
# Prerequisites:
#   - Emscripten SDK (emsdk) installed and activated
#   - libtropic submodule cloned at ../lib/libtropic
#
# Usage:
#   cd wasm && ./build.sh
#
# Output:
#   ../libtropic.js   — JS loader/glue
#   ../libtropic.wasm — WebAssembly binary
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LT_DIR="$PROJECT_ROOT/lib/libtropic"
OUT_DIR="$PROJECT_ROOT"

# Verify Emscripten is available
if ! command -v emcc &>/dev/null; then
    echo "Error: emcc not found. Install and activate Emscripten SDK first."
    echo "  git clone https://github.com/emscripten-core/emsdk.git"
    echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest"
    echo "  source ./emsdk_env.sh"
    exit 1
fi

# Verify libtropic is cloned
if [ ! -f "$LT_DIR/include/libtropic.h" ]; then
    echo "Error: libtropic not found at $LT_DIR"
    echo "  git submodule add https://github.com/tropicsquare/libtropic.git lib/libtropic"
    echo "  git submodule update --init"
    exit 1
fi

# --- Source files ---

# libtropic core sources
LT_SOURCES=(
    "$LT_DIR/src/libtropic.c"
    "$LT_DIR/src/lt_crc16.c"
    "$LT_DIR/src/lt_port_wrap.c"
    "$LT_DIR/src/lt_l1.c"
    "$LT_DIR/src/libtropic_l2.c"
    "$LT_DIR/src/lt_l2_frame_check.c"
    "$LT_DIR/src/lt_l3_process.c"
    "$LT_DIR/src/libtropic_l3.c"
    "$LT_DIR/src/lt_hkdf.c"
    "$LT_DIR/src/lt_asn1_der.c"
    "$LT_DIR/src/libtropic_default_sh0_keys.c"
    "$LT_DIR/src/lt_tr01_attrs.c"
    "$LT_DIR/src/libtropic_secure_memzero.c"
)

# Crypto abstraction layer — trezor-crypto (lightweight, no external deps)
CAL_DIR="$LT_DIR/cal/trezor_crypto"
CAL_SOURCES=()
if [ -d "$CAL_DIR" ]; then
    for f in "$CAL_DIR"/*.c; do
        [ -f "$f" ] && CAL_SOURCES+=("$f")
    done
fi

# trezor-crypto library sources (if bundled)
TREZOR_DIR="$LT_DIR/vendor/trezor-crypto"
TREZOR_SOURCES=()
if [ -d "$TREZOR_DIR" ]; then
    # Only compile the files we need for the CAL
    for f in \
        "$TREZOR_DIR/sha2.c" \
        "$TREZOR_DIR/hmac.c" \
        "$TREZOR_DIR/memzero.c" \
        "$TREZOR_DIR/ed25519-donna/curve25519-donna-scalarmult-base.c" \
        ; do
        [ -f "$f" ] && TREZOR_SOURCES+=("$f")
    done
fi

# Custom HAL
HAL_SOURCE="$SCRIPT_DIR/hal_webserial.c"

# --- Include paths ---
INCLUDES=(
    "-I$LT_DIR/include"
    "-I$LT_DIR/src"
)

# Add CAL includes if available
[ -d "$CAL_DIR" ] && INCLUDES+=("-I$CAL_DIR")
[ -d "$TREZOR_DIR" ] && INCLUDES+=("-I$TREZOR_DIR" "-I$TREZOR_DIR/ed25519-donna")

# --- Exported functions ---
EXPORTED_FUNCTIONS=$(cat <<'FUNCS'
[
  "_lt_init",
  "_lt_deinit",
  "_lt_random_value_get",
  "_lt_ecc_eddsa_sign",
  "_lt_ecc_key_read",
  "_lt_session_abort",
  "_lt_verify_chip_and_start_secure_session",
  "_lt_session_start",
  "_malloc",
  "_free"
]
FUNCS
)

# Remove whitespace for emcc
EXPORTED_FUNCTIONS=$(echo "$EXPORTED_FUNCTIONS" | tr -d ' \n')

# --- Compile ---
echo "Building libtropic WASM..."
echo "  Sources: ${#LT_SOURCES[@]} core + ${#CAL_SOURCES[@]} CAL + ${#TREZOR_SOURCES[@]} trezor + 1 HAL"

emcc \
    -O2 \
    -sASYNCIFY \
    -sASYNCIFY_STACK_SIZE=65536 \
    -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
    -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","setValue","getValue"]' \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=1048576 \
    -sMODULARIZE=1 \
    -sEXPORT_NAME='LibtropicModule' \
    -sENVIRONMENT='web' \
    -DLT_HELPERS=1 \
    -DACAB=1 \
    ${INCLUDES[@]} \
    ${LT_SOURCES[@]} \
    ${CAL_SOURCES[@]+"${CAL_SOURCES[@]}"} \
    ${TREZOR_SOURCES[@]+"${TREZOR_SOURCES[@]}"} \
    "$HAL_SOURCE" \
    -o "$OUT_DIR/libtropic.js"

echo ""
echo "Build complete!"
echo "  $OUT_DIR/libtropic.js"
echo "  $OUT_DIR/libtropic.wasm"
echo ""
echo "To use: serve the project directory with a local HTTP server"
echo "  python3 -m http.server 8080"
