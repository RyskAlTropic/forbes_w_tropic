# Web Slot Machine with TROPIC01 Integration

A web-based slot machine game with optional **hardware-backed true random number generation** and **provably fair gaming** powered by the [TROPIC01](https://tropicsquare.com) secure element.

## Preview

![Web Slot Machine Preview](https://github.com/user-attachments/assets/142c51aa-abf3-4f8e-8379-a2070a25fec9)

## Features

* Simple and easy-to-use interface
* Randomized reel spins with winning combinations and payouts
* **TROPIC01 integration** — hardware TRNG for true randomness
* **Provably fair** — each spin signed with EdDSA (Ed25519) on-chip
* **No backend required** — runs entirely in the browser via WebSerial
* Graceful fallback to `Math.random()` without hardware

## How It Works

```
Browser (Chrome/Edge)          USB              Devkit          Chip
  index.html                     |                |               |
  script.js ──WebSerial API──►   | ──USB CDC──►   | ──SPI──►  TROPIC01
  libtropic.wasm                 |                |            (TRNG, EdDSA)
```

The game uses [libtropic](https://github.com/tropicsquare/libtropic) compiled to WebAssembly, communicating with the TROPIC01 devkit via the browser's WebSerial API. No server needed.

## Quick Start

### Play without TROPIC01

Open `index.html` in any browser. The game works with `Math.random()` by default.

### Play with TROPIC01 (provably fair)

**Requirements:** Chrome or Edge, TROPIC01 devkit connected via USB, Emscripten SDK

#### Install Emscripten SDK

```bash
# Clone the Emscripten SDK
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk

# Install and activate the latest version
./emsdk install latest
./emsdk activate latest

# Set up environment variables (run this in every new terminal, or add to your shell profile)
source ./emsdk_env.sh

# Verify installation
emcc --version
```

> **Tip:** To avoid running `source ./emsdk_env.sh` every time, add it to your `~/.bashrc` or `~/.zshrc`:
> ```bash
> echo 'source /path/to/emsdk/emsdk_env.sh' >> ~/.zshrc
> ```

#### Build and Run

```bash
# Clone with submodules
git clone --recurse-submodules <repo-url>
cd forbes_w_tropic

# Build WASM
cd wasm && ./build.sh && cd ..

# Serve locally (WebSerial requires HTTPS or localhost)
python3 -m http.server 8080
```

1. Open `http://localhost:8080` in Chrome/Edge
2. Click **"Connect TROPIC01"** — select the devkit from the serial picker
3. Status shows **"Connected"** with green indicator
4. Spin — reels determined by TROPIC01 TRNG, signature shown in fairness panel
5. Click **"Verify"** to check the EdDSA signature

## Code Structure

| File | Purpose |
|------|---------|
| `index.html` | Game layout and TROPIC01 UI elements |
| `script.js` | Game logic with dual-mode spin (TRNG / Math.random) |
| `style.css` | Styling |
| `tropic.js` | `TropicBridge` class — WebSerial + WASM bridge |
| `wasm/hal_webserial.c` | Custom libtropic HAL for WebSerial |
| `wasm/build.sh` | Emscripten build script |
| `lib/libtropic/` | libtropic library (git submodule) |

## TROPIC01 Provably Fair Gaming

Each spin with TROPIC01 connected produces:

- **3 random bytes** from the hardware TRNG (mapped to reel indices)
- **EdDSA signature** (Ed25519) of the spin result, signed on-chip
- **Public key** for independent verification

The private signing key never leaves the TROPIC01 chip, making it impossible to forge results.

## Contributing

Feel free to contribute by submitting pull requests or reporting issues.

## License

This project is licensed under the MIT License.
