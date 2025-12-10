/**
 * Device Activity Tracker - CLI Interface
 *
 * This is a proof-of-concept tool demonstrating privacy vulnerabilities
 * in messaging apps (in this case WhatsApp) through RTT-based activity analysis.
 *
 * For educational and research purposes only.
 */

import '@whiskeysockets/baileys';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, WASocket } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import { WhatsAppTracker } from './tracker';
import { validatePhoneNumber, createWhatsAppJid } from './utils/validation';
import * as readline from 'readline';

// Check for debug mode from command line arguments
const debugMode = process.argv.includes('--debug') || process.argv.includes('-d');

if (debugMode) {
    console.log('🔍 Debug mode enabled\n');
} else {
    console.log('📊 Normal mode (important outputs only)\n');
    console.log('💡 Tip: Use --debug or -d for detailed debug output\n');
}

let currentTargetJid: string | null = null;
let currentTracker: WhatsAppTracker | null = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock: WASocket = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: true,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            // Stop the tracker if it's running, as the socket is dead
            if (currentTracker) {
                currentTracker.stopTracking();
                currentTracker = null;
            }

            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed due to', lastDisconnect?.error, ', reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection opened');

            if (currentTargetJid) {
                console.log(`Resuming tracking for ${currentTargetJid}...`);
                currentTracker = new WhatsAppTracker(sock, currentTargetJid, debugMode);
                currentTracker.startTracking();
            } else {
                askForTarget(sock);
            }
        } else {
            console.log('connection update', update);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

function askForTarget(sock: WASocket) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('Enter target phone number (with country code, e.g., 491701234567): ', async (number) => {
        // Validate phone number
        const validation = validatePhoneNumber(number);
        
        if (!validation.isValid) {
            console.log(`Invalid number: ${validation.error}`);
            rl.close();
            askForTarget(sock);
            return;
        }

        const targetJid = createWhatsAppJid(validation.cleaned);

        console.log(`Verifying ${targetJid}...`);
        try {
            const results = await sock.onWhatsApp(targetJid);
            const result = results?.[0];

            if (result?.exists) {
                console.log(`Target verified: ${result.jid}`);
                currentTargetJid = result.jid;
                currentTracker = new WhatsAppTracker(sock, result.jid, debugMode);
                currentTracker.startTracking();
                rl.close();
            } else {
                console.log('Number not registered on WhatsApp.');
                rl.close();
                askForTarget(sock);
            }
        } catch (err) {
            console.error('Error verifying number:', err);
            rl.close();
            askForTarget(sock);
        }
    });
}

connectToWhatsApp();
