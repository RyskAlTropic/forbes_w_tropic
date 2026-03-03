/**
 * Custom HAL for libtropic — routes SPI I/O through WebSerial via Emscripten.
 *
 * The TROPIC01 devkit exposes a USB CDC serial interface that bridges
 * USB serial ↔ SPI to the TROPIC01 chip. This HAL uses Emscripten's
 * EM_ASYNC_JS to call JavaScript WebSerial read/write from synchronous C code,
 * with Asyncify handling the async-to-sync bridging.
 *
 * Protocol over serial (devkit USB dongle bridge):
 *   TX: [offset (1 byte)] [tx_len (2 bytes LE)] [data (tx_len bytes)]
 *   RX: [status (1 byte)] [data (tx_len bytes)]
 */

#include "libtropic_common.h"
#include "libtropic_port.h"

#include <emscripten.h>
#include <string.h>
#include <stdarg.h>
#include <stdio.h>

/* ------------------------------------------------------------------ */
/* JavaScript-side WebSerial read/write via EM_ASYNC_JS (Asyncify)    */
/* ------------------------------------------------------------------ */

/**
 * Send data over WebSerial. The JS side accesses the WASM heap directly.
 * Returns 0 on success, -1 on failure.
 */
EM_ASYNC_JS(int, js_serial_write, (const uint8_t *data, int len), {
    try {
        if (!Module._serialWriter) return -1;
        const buf = Module.HEAPU8.slice(data, data + len);
        await Module._serialWriter.write(buf);
        return 0;
    } catch (e) {
        console.error('WebSerial write error:', e);
        return -1;
    }
});

/**
 * Read data from WebSerial into the WASM heap buffer.
 * Reads exactly `len` bytes (blocking via Asyncify).
 * Returns 0 on success, -1 on failure/timeout.
 */
EM_ASYNC_JS(int, js_serial_read, (uint8_t *buf, int len, int timeout_ms), {
    try {
        if (!Module._serialReader) return -1;
        let offset = 0;
        const deadline = Date.now() + timeout_ms;
        while (offset < len) {
            if (Date.now() > deadline) {
                console.error('WebSerial read timeout');
                return -1;
            }
            const { value, done } = await Module._serialReader.read();
            if (done || !value) return -1;
            for (let i = 0; i < value.length && offset < len; i++, offset++) {
                Module.HEAPU8[buf + offset] = value[i];
            }
        }
        return 0;
    } catch (e) {
        console.error('WebSerial read error:', e);
        return -1;
    }
});

/**
 * Async delay implemented in JS (non-blocking via Asyncify).
 */
EM_ASYNC_JS(void, js_delay_ms, (int ms), {
    await new Promise(resolve => setTimeout(resolve, ms));
});

/**
 * Get cryptographically secure random bytes from browser's crypto API.
 */
EM_JS(void, js_get_random_bytes, (uint8_t *buf, int count), {
    const bytes = new Uint8Array(count);
    crypto.getRandomValues(bytes);
    Module.HEAPU8.set(bytes, buf);
});

/* ------------------------------------------------------------------ */
/* libtropic HAL implementation (libtropic_port.h interface)          */
/* ------------------------------------------------------------------ */

lt_ret_t lt_port_init(lt_l2_state_t *s2)
{
    /* Hardware init is handled on the JS side (port.open()).
     * Nothing to do here — the WebSerial port is already open
     * by the time WASM functions are called. */
    (void)s2;
    return LT_OK;
}

lt_ret_t lt_port_deinit(lt_l2_state_t *s2)
{
    (void)s2;
    return LT_OK;
}

lt_ret_t lt_port_spi_csn_low(lt_l2_state_t *s2)
{
    /* The devkit bridge handles CS automatically for each transfer.
     * Send a CS_LOW command byte (0x01) to the bridge. */
    (void)s2;
    uint8_t cmd = 0x01; /* CS_LOW command */
    if (js_serial_write(&cmd, 1) != 0) return LT_FAIL;
    return LT_OK;
}

lt_ret_t lt_port_spi_csn_high(lt_l2_state_t *s2)
{
    /* Send CS_HIGH command byte (0x02) to the bridge. */
    (void)s2;
    uint8_t cmd = 0x02; /* CS_HIGH command */
    if (js_serial_write(&cmd, 1) != 0) return LT_FAIL;
    return LT_OK;
}

lt_ret_t lt_port_spi_transfer(lt_l2_state_t *s2, uint8_t offset, uint16_t tx_len, uint32_t timeout_ms)
{
    /*
     * Full-duplex SPI transfer via the devkit USB bridge.
     *
     * Protocol:
     *   Host → Bridge: [0x03 (TRANSFER cmd)] [tx_len (2B LE)] [data (tx_len bytes)]
     *   Bridge → Host: [status (1B)] [rx_data (tx_len bytes)]
     *
     * Data is read from / written back to s2->buff[offset].
     */
    if (tx_len == 0) return LT_OK;

    /* Build command frame: [0x03] [len_lo] [len_hi] [data...] */
    uint8_t header[3];
    header[0] = 0x03; /* TRANSFER command */
    header[1] = (uint8_t)(tx_len & 0xFF);
    header[2] = (uint8_t)((tx_len >> 8) & 0xFF);

    /* Send header */
    if (js_serial_write(header, 3) != 0) return LT_FAIL;

    /* Send TX data from s2->buff[offset] */
    if (js_serial_write(&s2->buff[offset], tx_len) != 0) return LT_FAIL;

    /* Read response: [status (1B)] [rx_data (tx_len bytes)] */
    uint8_t status;
    if (js_serial_read(&status, 1, timeout_ms) != 0) return LT_FAIL;
    if (status != 0x00) return LT_FAIL;

    /* Read RX data back into s2->buff[offset] */
    if (js_serial_read(&s2->buff[offset], tx_len, timeout_ms) != 0) return LT_FAIL;

    return LT_OK;
}

lt_ret_t lt_port_delay(lt_l2_state_t *s2, uint32_t ms)
{
    (void)s2;
    js_delay_ms((int)ms);
    return LT_OK;
}

lt_ret_t lt_port_random_bytes(lt_l2_state_t *s2, void *buff, size_t count)
{
    (void)s2;
    js_get_random_bytes((uint8_t *)buff, (int)count);
    return LT_OK;
}

int lt_port_log(const char *format, ...)
{
    char buf[512];
    va_list args;
    va_start(args, format);
    int ret = vsnprintf(buf, sizeof(buf), format, args);
    va_end(args);

    /* Forward to browser console */
    EM_ASM({ console.log('[libtropic] ' + UTF8ToString($0)); }, buf);

    return ret;
}
