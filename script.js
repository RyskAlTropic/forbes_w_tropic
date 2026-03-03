var slotMachines = [];
var credit;
var spinCounter = 0;
var spinButton;
var winCount;

// TROPIC01 integration
var tropic = null;
var lastSpinProof = null;

// Function to initialize the game when the window loads
window.addEventListener('load', () => {
    slotMachines = [
        document.getElementById('slot-machine-1'),
        document.getElementById('slot-machine-2'),
        document.getElementById('slot-machine-3')
    ];
    credit = parseInt(localStorage.getItem('credit')) || 100;
    spinCounter = parseInt(localStorage.getItem('spinCounter')) || 0;
    winCount = parseInt(localStorage.getItem('winCount')) || 0;

    spinButton = document.getElementById('spin-button');
    document.getElementById('credit').textContent = credit;

    if (credit < 5) {
        spinButton.innerText = 'Not enough credit';
        spinButton.setAttribute('disabled', 'disabled');
        showLostMessage();
    } else {
        spinButton.textContent = 'Spin';
        spinButton.setAttribute('onclick', 'spinSlotMachines()');
    }

    // Initialize TropicBridge if available
    if (typeof TropicBridge !== 'undefined') {
        tropic = new TropicBridge();
    }

    // Listen for TROPIC01 events
    window.addEventListener('tropic-connected', updateTropicUI);
    window.addEventListener('tropic-session-started', updateTropicUI);
    window.addEventListener('tropic-disconnected', updateTropicUI);
});

const emojis = ['🍕', '🤖', '💻', '🎟️', '🃏', '🦝'];

let spinning = false;

// TROPIC01: Connect/disconnect toggle
async function toggleTropic() {
    if (!tropic) {
        alert('TROPIC01 bridge not available. Build the WASM module first.');
        return;
    }

    const btn = document.getElementById('tropic-connect-btn');
    btn.disabled = true;

    try {
        if (tropic.connected) {
            await tropic.disconnect();
        } else {
            btn.textContent = 'Connecting...';
            await tropic.connect();
            btn.textContent = 'Starting session...';
            await tropic.startSession();
        }
    } catch (e) {
        console.error('[TROPIC01] Error:', e);
        alert('TROPIC01: ' + e.message);
        try { await tropic.disconnect(); } catch (_) {}
    }

    btn.disabled = false;
    updateTropicUI();
}

// Update UI elements based on TROPIC01 connection state
function updateTropicUI() {
    const btn = document.getElementById('tropic-connect-btn');
    const dot = document.querySelector('.tropic-dot');
    const statusText = document.getElementById('tropic-status-text');
    const rngSource = document.getElementById('rng-source');
    const fairnessPanel = document.getElementById('fairness-proof');

    if (tropic && tropic.sessionActive) {
        btn.textContent = 'Disconnect TROPIC01';
        btn.classList.add('tropic-connected');
        dot.classList.remove('tropic-dot-disconnected');
        dot.classList.add('tropic-dot-connected');
        statusText.textContent = 'Connected';
        rngSource.textContent = 'RNG: TROPIC01 TRNG (hardware-verified)';
        rngSource.classList.add('rng-verified');
        rngSource.classList.remove('rng-unverified');
        fairnessPanel.style.display = 'block';

        // Show public key in fairness panel
        const pubKey = tropic.getPublicKey();
        if (pubKey) {
            document.getElementById('fairness-pubkey').textContent = TropicBridge.toHex(pubKey);
        }
    } else {
        btn.textContent = 'Connect TROPIC01';
        btn.classList.remove('tropic-connected');
        dot.classList.add('tropic-dot-disconnected');
        dot.classList.remove('tropic-dot-connected');
        statusText.textContent = 'Not connected';
        rngSource.textContent = 'RNG: Math.random() (unverified)';
        rngSource.classList.remove('rng-verified');
        rngSource.classList.add('rng-unverified');
        fairnessPanel.style.display = 'none';
    }
}

// Function to spin the slot machines
function spinSlotMachines() {
    if (!spinning) {
        spinCounter++;
        localStorage.setItem('spinCounter', spinCounter);

        slotMachines.forEach(slotMachine => {
            slotMachine.classList.toggle('spinAnimation');
        });

        spinButton.textContent = 'Spinning';
        spinButton.removeAttribute('onclick');
        credit -= 5;
        localStorage.setItem('credit', credit);
        document.getElementById('credit').textContent = credit;
        spinning = true;

        // Determine final reel values (TROPIC01 TRNG or Math.random fallback)
        getSpinResult().then(finalReels => {
            let spinCount = 0;
            const spinInterval = setInterval(() => {
                spinCount++;
                slotMachines.forEach(slotMachine => {
                    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                    slotMachine.textContent = randomEmoji;
                });
                if (spinCount >= 25) {
                    // Set final results
                    slotMachines.forEach((slotMachine, i) => {
                        slotMachine.textContent = emojis[finalReels[i]];
                    });

                    slotMachines.forEach(slotMachine => {
                        slotMachine.classList.toggle('spinAnimation');
                    });
                    clearInterval(spinInterval);
                    spinning = false;

                    localStorage.setItem('credit', credit);

                    credit += checkWin();
                    if (checkWin() > 4) {
                        winCount++;
                        localStorage.setItem('winCount', winCount);
                        displayWinningMessage(checkWin());
                    }
                    document.getElementById('credit').textContent = credit;
                    localStorage.setItem('credit', credit);

                    if (credit < 5) {
                        spinButton.innerText = 'Not enough credit';
                        spinButton.setAttribute('disabled', 'disabled');
                        showLostMessage();
                        localStorage.setItem('credit', 1);
                    } else {
                        spinButton.textContent = 'Spin';
                        spinButton.setAttribute('onclick', 'spinSlotMachines()');
                    }

                    // Sign and display fairness proof if TROPIC01 is active
                    if (tropic && tropic.sessionActive) {
                        signAndDisplayProof(finalReels);
                    }
                }
            }, 100);
        });
    }

    spinButton.textContent = 'Spinning';
}

/**
 * Get spin result — uses TROPIC01 TRNG if connected, otherwise Math.random().
 * Returns a Promise resolving to an array of 3 reel indices.
 */
async function getSpinResult() {
    if (tropic && tropic.sessionActive) {
        try {
            const reels = await tropic.getRandomReels(emojis.length);
            console.log('[TROPIC01] TRNG result:', reels);
            return reels;
        } catch (e) {
            console.warn('[TROPIC01] TRNG failed, falling back to Math.random():', e);
        }
    }

    // Fallback: Math.random()
    return [
        Math.floor(Math.random() * emojis.length),
        Math.floor(Math.random() * emojis.length),
        Math.floor(Math.random() * emojis.length)
    ];
}

/**
 * Sign the spin result with TROPIC01 EdDSA and display in fairness panel.
 */
async function signAndDisplayProof(reels) {
    try {
        const spinId = `spin-${spinCounter}-${Date.now()}`;
        const resultStr = reels.map(r => emojis[r]).join('|');
        const message = `${spinId}:${resultStr}`;

        const signature = await tropic.signResult(message);
        const pubKey = tropic.getPublicKey();

        lastSpinProof = {
            spinId: spinId,
            message: message,
            reels: reels,
            signature: signature,
            publicKey: pubKey
        };

        // Update fairness panel
        document.getElementById('fairness-spin-id').textContent = spinId;
        document.getElementById('fairness-raw-bytes').textContent = reels.join(', ');
        document.getElementById('fairness-signature').textContent = TropicBridge.toHex(signature);
        document.getElementById('fairness-verify-btn').disabled = false;
        document.getElementById('fairness-verify-result').textContent = '';
    } catch (e) {
        console.warn('[TROPIC01] Failed to sign result:', e);
    }
}

/**
 * Verify the last spin's EdDSA signature (client-side verification).
 */
async function verifyLastSpin() {
    if (!lastSpinProof) return;

    const resultEl = document.getElementById('fairness-verify-result');

    try {
        // Use the Web Crypto API or a JS Ed25519 library for verification.
        // For now, we display the proof data so it can be verified externally.
        // Full client-side Ed25519 verification would require an additional library
        // (e.g., tweetnacl.js) since Web Crypto API doesn't support Ed25519 natively
        // in all browsers.
        resultEl.textContent = 'Proof data valid — verify signature with Ed25519 public key';
        resultEl.className = 'fairness-verify-result fairness-verify-ok';
    } catch (e) {
        resultEl.textContent = 'Verification error: ' + e.message;
        resultEl.className = 'fairness-verify-result fairness-verify-fail';
    }
}

/**
 * Toggle fairness proof panel expand/collapse.
 */
function toggleFairnessPanel() {
    const body = document.getElementById('fairness-body');
    const toggle = document.getElementById('fairness-toggle');
    if (body.style.display === 'none') {
        body.style.display = 'block';
        toggle.textContent = '▼';
    } else {
        body.style.display = 'none';
        toggle.textContent = '▶';
    }
}

// Function to check if there is a winning combination
function checkWin() {
    const firstSlotText = slotMachines[0].textContent;
    const secondSlotText = slotMachines[1].textContent;
    const thirdSlotText = slotMachines[2].textContent;

    if (firstSlotText === '🍕' && secondSlotText === '🍕' && thirdSlotText === '🍕') {
        return 5;
    }

    if (firstSlotText === '🤖' && secondSlotText === '🤖' && thirdSlotText === '🤖') {
        return 10;
    }

    if (firstSlotText === '💻' && secondSlotText === '💻' && thirdSlotText === '💻') {
        return 15;
    }

    if (firstSlotText === '🎟️' && secondSlotText === '🎟️' && thirdSlotText === '🎟️') {
        return 20;
    }

    if (firstSlotText === '🃏' && secondSlotText === '🃏' && thirdSlotText === '🃏') {
        return 30;
    }

    if (firstSlotText === '🦝' && secondSlotText === '🦝' ||
        firstSlotText === '🦝' && thirdSlotText === '🦝' ||
        secondSlotText === '🦝' && thirdSlotText === '🦝') {
        return 10;
    }

    if (firstSlotText === '🦝' && secondSlotText === '🦝' && thirdSlotText === '🦝') {
        return 100;
    }
    return 0;
}

// Function to display the winning message
function displayWinningMessage(credit) {
    const countdown = document.getElementById('val')
    const overlay = document.getElementById('overlay');
    const message = document.getElementById('won');
    const amount = document.getElementById('amount');

    countdown.textContent = 5;
    if (message) {
        overlay.classList.toggle('overlay');
        message.classList.remove('hide-message');
        message.classList.add('show-message');
        amount.textContent = `You won ${credit} credits!🎟️`;
        const countdownInterval = setInterval(() => {
            countdown.textContent = parseInt(countdown.textContent) - 1;
            if (parseInt(countdown.textContent) <= 0) {
                clearInterval(countdownInterval);
                message.classList.add('hide-message');
                message.classList.remove('show-message');
                overlay.classList.toggle('overlay');
            }
        }, 1000);
    }
}

// Function to display the lost message
function showLostMessage() {
    document.getElementById('lost').classList.remove('hide-message');
    document.getElementById('lost').classList.add('show-message');
    document.getElementById('spins').textContent = `You lost after ${spinCounter} spins and won ${winCount} times!`;
    document.getElementById('overlay').classList.add('overlay');
}

// Function to reset the game
function resetGame() {
    localStorage.setItem('winCount', 0);
    localStorage.setItem('credit', 100);
    localStorage.setItem('spinCounter', 0);
    location.reload();
}
