# Technical Knowledge Base

## Technologies

### Core Web
- **HTML/CSS/JS** — Vanilla, no frameworks or bundlers
- **localStorage** — Persists credits, spin counter, win count

### WebSerial API
- Browser API for communicating with serial devices (USB CDC)
- Chromium-only (Chrome, Edge) — requires user gesture to request port
- `navigator.serial.requestPort()` opens device picker dialog
- `port.open({ baudRate: 115200 })` — standard serial config
- Read/write via `ReadableStream` / `WritableStream`
- Requires HTTPS or localhost

### Emscripten SDK
- C/C++ to WebAssembly compiler toolchain
- Install: `git clone https://github.com/emscripten-core/emsdk.git`
- Setup: `./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh`
- Must run `source ./emsdk_env.sh` in each new terminal (or add to shell profile)
- Provides `emcc` compiler, used by `wasm/build.sh`

### WebAssembly (WASM)
- libtropic C library compiled to WASM via Emscripten
- **Asyncify** bridges async JavaScript (WebSerial) with synchronous C code
- `EM_ASYNC_JS` macro allows C functions to `await` JavaScript promises
- Module exports wrapped with `cwrap()` for easy JS calling
- `MODULARIZE=1` exports as `LibtropicModule()` factory function

### libtropic
- C library for communicating with TROPIC01 secure element
- Layered architecture: L1 (SPI transport) → L2 (framing) → L3 (encrypted commands)
- HAL (Hardware Abstraction Layer) via `libtropic_port.h`:
  - `lt_port_init/deinit` — hardware lifecycle
  - `lt_port_spi_csn_low/high` — chip select control
  - `lt_port_spi_transfer` — full-duplex SPI via `s2->buff[offset]`
  - `lt_port_delay` — millisecond delay
  - `lt_port_random_bytes` — host-side RNG (for session keys)
  - `lt_port_log` — debug logging
- CAL (Crypto Abstraction Layer) — AES-GCM, SHA-256, HMAC, X25519
- Uses trezor-crypto backend for WASM build (lightweight, no deps)

## TROPIC01 Secure Element

### Capabilities
- **TRNG** — True Random Number Generator (hardware entropy source)
- **EdDSA** — Ed25519 digital signatures (on-chip private key, never leaves the chip)
- **ECDSA** — P-256 signatures
- **Secure storage** — Key slots for ECC keys and user data
- **X25519** — ECDH key exchange for secure sessions
- **AES-GCM** — Encrypted communication channel (L3)

### Key API Functions
| Function | Purpose |
|----------|---------|
| `lt_init` | Initialize handle and transport |
| `lt_verify_chip_and_start_secure_session` | Authenticate chip + establish encrypted session |
| `lt_random_value_get` | Get up to 255 random bytes from TRNG |
| `lt_ecc_eddsa_sign` | Sign data with Ed25519 (max 4096 bytes) |
| `lt_ecc_key_read` | Read public key from ECC slot |
| `lt_session_abort` | End secure session |
| `lt_deinit` | Clean up handle |

### Devkit
- USB CDC serial device (appears as `/dev/ttyACMx` or COM port)
- Bridges USB serial ↔ SPI to TROPIC01 chip
- Default baud rate: 115200
- Engineering sample ships with default pairing keys (slot 0)

## Provably Fair Gaming

### Concept
The slot machine outcome is determined by TROPIC01's hardware TRNG, not software pseudorandom.
Each spin result is signed with an EdDSA private key that never leaves the chip, creating
a cryptographic proof that:

1. The random bytes came from TROPIC01's TRNG
2. The specific result was produced (not tampered with after the fact)
3. Anyone with the public key can verify the signature

### Verification Flow
1. TROPIC01 generates 3 random bytes → mapped to reel indices
2. Result string `"spin-N-timestamp:emoji1|emoji2|emoji3"` is signed
3. 64-byte EdDSA signature (r || s) displayed in fairness panel
4. Public key available for independent verification
5. Verify: Ed25519 signature check on (message, signature, public key)

### Limitations
- Credits are client-side (localStorage) — not authoritative
- Client-side verification requires an Ed25519 JS library (e.g., tweetnacl)
- WebSerial is Chromium-only — acceptable for demo/PoC
