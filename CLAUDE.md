# Slot Machine with TROPIC01 Integration

## Architecture

Browser-only slot machine game with optional hardware-backed TRNG via TROPIC01 secure element.

```
Browser (Chrome/Edge)          USB              Devkit          Chip
  index.html                     |                |               |
  script.js ──WebSerial API──►   | ──USB CDC──►   | ──SPI──►  TROPIC01
  libtropic.wasm (WASM)          |                |            (TRNG, EdDSA)
  tropic.js (bridge)
```

- **No backend server** — everything runs in the browser
- **WebSerial API** communicates directly with the TROPIC01 devkit (Chromium-only)
- **libtropic** compiled to WebAssembly via Emscripten with Asyncify
- **Graceful fallback** — game works without TROPIC01 using `Math.random()`

## Key Files

| File | Purpose |
|------|---------|
| `index.html` | Game layout + TROPIC01 UI (connect button, fairness panel) |
| `script.js` | Game logic, dual-mode spin (TRNG vs Math.random) |
| `style.css` | Styling including TROPIC01 UI elements |
| `tropic.js` | `TropicBridge` class — high-level JS API for TROPIC01 |
| `wasm/hal_webserial.c` | Custom libtropic HAL routing I/O through WebSerial |
| `wasm/build.sh` | Emscripten build script for libtropic → WASM |
| `lib/libtropic/` | libtropic submodule (git submodule) |
| `libtropic.js` | WASM loader/glue (build output) |
| `libtropic.wasm` | WebAssembly binary (build output) |

## Build Commands

```bash
# One-time setup
git submodule add https://github.com/tropicsquare/libtropic.git lib/libtropic
git submodule update --init

# Build WASM (requires Emscripten SDK)
cd wasm && ./build.sh

# Serve locally
python3 -m http.server 8080
```

## Coding Conventions

- **No frameworks** — vanilla HTML/CSS/JS only
- **No bundler** — files loaded directly via `<script>` tags
- `script.js` is loaded last (after `libtropic.js` and `tropic.js`)
- `libtropic.js` loads with `onerror` fallback (optional dependency)
- Credits stored in `localStorage`
- All TROPIC01 interaction goes through the `TropicBridge` class in `tropic.js`

## TROPIC01 Integration Notes

- `TropicBridge` is instantiated in `script.js` on page load
- Connect flow: `connect()` → `startSession()` → ready for `getRandomReels()` / `signResult()`
- The HAL uses Emscripten `EM_ASYNC_JS` to bridge async WebSerial with synchronous C code
- Default engineering sample pairing keys are compiled into libtropic
- EdDSA signatures use Ed25519 (key slot 0)
