/**
 * TropicBridge — High-level JavaScript bridge for TROPIC01 via WebSerial + WASM.
 *
 * Provides hardware-backed TRNG and EdDSA signing for provably fair gaming.
 * Uses libtropic compiled to WebAssembly with a custom HAL that routes
 * SPI I/O through the browser's WebSerial API to the TROPIC01 devkit.
 *
 * Usage:
 *   const tropic = new TropicBridge();
 *   await tropic.connect();      // User picks serial device
 *   await tropic.startSession(); // Handshake with TROPIC01
 *   const reels = await tropic.getRandomReels();  // [0-5, 0-5, 0-5]
 *   const sig = await tropic.signResult(data);    // EdDSA signature
 *   await tropic.disconnect();
 */

class TropicBridge {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.connected = false;
        this.sessionActive = false;
        this.module = null;
        this.handlePtr = null;
        this.publicKey = null;

        // WASM function wrappers (populated after module load)
        this._lt_init = null;
        this._lt_deinit = null;
        this._lt_random_value_get = null;
        this._lt_ecc_eddsa_sign = null;
        this._lt_ecc_key_read = null;
        this._lt_session_abort = null;
        this._lt_verify_chip_and_start_secure_session = null;
    }

    /**
     * Load the libtropic WASM module.
     * Must be called before connect().
     */
    async loadWasm() {
        if (this.module) return;

        if (typeof LibtropicModule === 'undefined') {
            throw new Error('libtropic.js not loaded. Include it via <script> tag before tropic.js');
        }

        this.module = await LibtropicModule();

        // Wrap exported C functions
        this._lt_init = this.module.cwrap('lt_init', 'number', ['number']);
        this._lt_deinit = this.module.cwrap('lt_deinit', 'number', ['number']);
        this._lt_random_value_get = this.module.cwrap('lt_random_value_get', 'number', ['number', 'number', 'number']);
        this._lt_ecc_eddsa_sign = this.module.cwrap('lt_ecc_eddsa_sign', 'number', ['number', 'number', 'number', 'number', 'number']);
        this._lt_ecc_key_read = this.module.cwrap('lt_ecc_key_read', 'number', ['number', 'number', 'number', 'number', 'number', 'number']);
        this._lt_session_abort = this.module.cwrap('lt_session_abort', 'number', ['number']);
        this._lt_verify_chip_and_start_secure_session = this.module.cwrap(
            'lt_verify_chip_and_start_secure_session', 'number', ['number', 'number', 'number', 'number']
        );

        console.log('[TropicBridge] WASM module loaded');
    }

    /**
     * Connect to the TROPIC01 devkit via WebSerial.
     * Triggers the browser's serial device picker dialog.
     */
    async connect() {
        if (!('serial' in navigator)) {
            throw new Error('WebSerial API not available. Use Chrome or Edge.');
        }

        await this.loadWasm();

        // Request serial port (user must pick the devkit)
        this.port = await navigator.serial.requestPort({
            filters: [] // Accept any serial device
        });

        await this.port.open({ baudRate: 115200 });

        // Set up reader/writer streams
        const textDecoder = new TextDecoderStream();
        const readableStream = this.port.readable;
        this.reader = readableStream.getReader();

        const writableStream = this.port.writable;
        this.writer = writableStream.getWriter();

        // Expose reader/writer to WASM HAL via Module globals
        this.module._serialReader = this.reader;
        this.module._serialWriter = this.writer;

        this.connected = true;
        console.log('[TropicBridge] Serial port connected');

        this._dispatchEvent('tropic-connected');
    }

    /**
     * Initialize libtropic handle and start a secure session with TROPIC01.
     */
    async startSession() {
        if (!this.connected) throw new Error('Not connected');
        if (!this.module) throw new Error('WASM not loaded');

        // Allocate lt_handle_t on the WASM heap
        // lt_handle_t is a large struct (~5KB), allocate generously
        const HANDLE_SIZE = 8192;
        this.handlePtr = this.module._malloc(HANDLE_SIZE);
        if (!this.handlePtr) throw new Error('Failed to allocate handle');

        // Zero-initialize
        this.module.HEAPU8.fill(0, this.handlePtr, this.handlePtr + HANDLE_SIZE);

        // Initialize libtropic
        let ret = this._lt_init(this.handlePtr);
        if (ret !== 0) {
            this.module._free(this.handlePtr);
            this.handlePtr = null;
            throw new Error(`lt_init failed with code ${ret}`);
        }

        // Start secure session using default engineering sample keys
        // The keys are compiled into libtropic (libtropic_default_sh0_keys.c)
        // Pairing key slot index 0
        ret = this._lt_verify_chip_and_start_secure_session(
            this.handlePtr,
            0, // shipriv — NULL uses default keys
            0, // shipub — NULL uses default keys
            0  // pkey_index = 0
        );

        if (ret !== 0) {
            this._lt_deinit(this.handlePtr);
            this.module._free(this.handlePtr);
            this.handlePtr = null;
            throw new Error(`Secure session failed with code ${ret}`);
        }

        this.sessionActive = true;
        console.log('[TropicBridge] Secure session established');

        // Fetch and cache the public key
        await this._fetchPublicKey();

        this._dispatchEvent('tropic-session-started');
    }

    /**
     * Get 3 random bytes from TROPIC01 TRNG and map to reel indices.
     * Returns an array of 3 values, each in range [0, emojiCount-1].
     */
    async getRandomReels(emojiCount = 6) {
        if (!this.sessionActive) throw new Error('No active session');

        const RND_BYTES = 3;
        const rndPtr = this.module._malloc(RND_BYTES);
        if (!rndPtr) throw new Error('Failed to allocate random buffer');

        try {
            const ret = this._lt_random_value_get(this.handlePtr, rndPtr, RND_BYTES);
            if (ret !== 0) throw new Error(`lt_random_value_get failed with code ${ret}`);

            const bytes = new Uint8Array(this.module.HEAPU8.buffer, rndPtr, RND_BYTES);
            const reels = Array.from(bytes).map(b => b % emojiCount);

            console.log('[TropicBridge] TRNG reels:', reels, 'raw bytes:', Array.from(bytes));
            return reels;
        } finally {
            this.module._free(rndPtr);
        }
    }

    /**
     * Sign arbitrary data using EdDSA (Ed25519) via TROPIC01.
     * @param {Uint8Array|string} data — data to sign
     * @param {number} eccSlot — ECC key slot (default 0)
     * @returns {Uint8Array} 64-byte EdDSA signature (r || s)
     */
    async signResult(data, eccSlot = 0) {
        if (!this.sessionActive) throw new Error('No active session');

        const msgBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const SIG_SIZE = 64;

        const msgPtr = this.module._malloc(msgBytes.length);
        const sigPtr = this.module._malloc(SIG_SIZE);
        if (!msgPtr || !sigPtr) throw new Error('Failed to allocate buffers');

        try {
            this.module.HEAPU8.set(msgBytes, msgPtr);

            const ret = this._lt_ecc_eddsa_sign(
                this.handlePtr, eccSlot, msgPtr, msgBytes.length, sigPtr
            );
            if (ret !== 0) throw new Error(`lt_ecc_eddsa_sign failed with code ${ret}`);

            const signature = new Uint8Array(SIG_SIZE);
            signature.set(new Uint8Array(this.module.HEAPU8.buffer, sigPtr, SIG_SIZE));

            console.log('[TropicBridge] Signed result, signature length:', signature.length);
            return signature;
        } finally {
            this.module._free(msgPtr);
            this.module._free(sigPtr);
        }
    }

    /**
     * Get the public key (cached after session start).
     * @returns {Uint8Array|null} 32-byte Ed25519 public key
     */
    getPublicKey() {
        return this.publicKey;
    }

    /**
     * Disconnect from the TROPIC01 devkit.
     */
    async disconnect() {
        try {
            if (this.sessionActive && this.handlePtr) {
                this._lt_session_abort(this.handlePtr);
                this.sessionActive = false;
            }

            if (this.handlePtr) {
                this._lt_deinit(this.handlePtr);
                this.module._free(this.handlePtr);
                this.handlePtr = null;
            }

            if (this.reader) {
                this.reader.releaseLock();
                this.reader = null;
            }

            if (this.writer) {
                this.writer.releaseLock();
                this.writer = null;
            }

            if (this.port) {
                await this.port.close();
                this.port = null;
            }
        } catch (e) {
            console.warn('[TropicBridge] Error during disconnect:', e);
        }

        this.connected = false;
        this.sessionActive = false;
        this.publicKey = null;

        if (this.module) {
            this.module._serialReader = null;
            this.module._serialWriter = null;
        }

        console.log('[TropicBridge] Disconnected');
        this._dispatchEvent('tropic-disconnected');
    }

    /**
     * Fetch and cache the Ed25519 public key from TROPIC01.
     * @private
     */
    async _fetchPublicKey() {
        const KEY_MAX_SIZE = 64; // Ed25519 pubkey is 32 bytes, but allow extra
        const keyPtr = this.module._malloc(KEY_MAX_SIZE);
        const curvePtr = this.module._malloc(4);
        const originPtr = this.module._malloc(4);

        if (!keyPtr || !curvePtr || !originPtr) {
            console.warn('[TropicBridge] Failed to allocate key buffers');
            return;
        }

        try {
            const ret = this._lt_ecc_key_read(
                this.handlePtr, 0, keyPtr, KEY_MAX_SIZE, curvePtr, originPtr
            );
            if (ret !== 0) {
                console.warn(`[TropicBridge] lt_ecc_key_read failed with code ${ret}`);
                return;
            }

            this.publicKey = new Uint8Array(32);
            this.publicKey.set(new Uint8Array(this.module.HEAPU8.buffer, keyPtr, 32));
            console.log('[TropicBridge] Public key cached');
        } finally {
            this.module._free(keyPtr);
            this.module._free(curvePtr);
            this.module._free(originPtr);
        }
    }

    /**
     * Dispatch a custom DOM event for UI updates.
     * @private
     */
    _dispatchEvent(name, detail = {}) {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    }

    /**
     * Convert a Uint8Array to hex string.
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    static toHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }
}
