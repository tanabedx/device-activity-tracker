/**
 * Device Activity Tracker - Web Server
 *
 * HTTP server with Socket.IO for real-time tracking visualization.
 * Provides REST API and WebSocket interface for the React frontend.
 *
 * For educational and research purposes only.
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, WASocket } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { Boom } from '@hapi/boom';
import { WhatsAppTracker } from './tracker';
import { config } from './config';
import { validatePhoneNumber, createWhatsAppJid } from './utils/validation';

const app = express();
app.use(cors({ origin: config.corsOrigin }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: config.corsOrigin,
        methods: ["GET", "POST"]
    }
});

let sock: WASocket | null = null;
let isWhatsAppConnected = false;
const trackers: Map<string, WhatsAppTracker> = new Map(); // JID -> Tracker instance

/**
 * Stop all active trackers - used during reconnection
 */
function stopAllTrackers() {
    for (const [jid, tracker] of trackers.entries()) {
        console.log(`[CLEANUP] Stopping tracker for ${jid}`);
        tracker.stopTracking();
    }
    trackers.clear();
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: true,
        printQRInTerminal: false,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code generated');
            io.emit('qr', qr);
        }

        if (connection === 'close') {
            isWhatsAppConnected = false;
            
            // Clean up all trackers when connection closes
            stopAllTrackers();
            io.emit('connection-closed');
            
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed, reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isWhatsAppConnected = true;
            console.log('WhatsApp connection opened');
            io.emit('connection-open');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
        console.log(`[SESSION] History sync - Chats: ${chats.length}, Contacts: ${contacts.length}, Messages: ${messages.length}, Latest: ${isLatest}`);
    });
}

connectToWhatsApp();

io.on('connection', (socket) => {
    console.log('Client connected');

    if (isWhatsAppConnected) {
        socket.emit('connection-open');
    }

    socket.emit('tracked-contacts', Array.from(trackers.keys()));

    socket.on('add-contact', async (number: string) => {
        console.log(`Request to track: ${number}`);
        
        // Validate phone number
        const validation = validatePhoneNumber(number);
        if (!validation.isValid) {
            socket.emit('error', { message: validation.error || 'Invalid phone number' });
            return;
        }

        const targetJid = createWhatsAppJid(validation.cleaned);

        if (trackers.has(targetJid)) {
            socket.emit('error', { jid: targetJid, message: 'Already tracking this contact' });
            return;
        }

        if (!sock) {
            socket.emit('error', { message: 'WhatsApp not connected' });
            return;
        }

        try {
            const results = await sock.onWhatsApp(targetJid);
            const result = results?.[0];

            if (result?.exists) {
                const tracker = new WhatsAppTracker(sock, result.jid);
                trackers.set(result.jid, tracker);

                tracker.onUpdate = (data) => {
                    io.emit('tracker-update', {
                        jid: result.jid,
                        ...data as object
                    });
                };

                tracker.startTracking();

                const ppUrl = await tracker.getProfilePicture();

                // Use phone number as the display name
                // Note: WhatsApp contact names are not available via the onWhatsApp API
                const contactName = validation.cleaned;

                socket.emit('contact-added', { jid: result.jid, number: validation.cleaned });

                io.emit('profile-pic', { jid: result.jid, url: ppUrl });
                io.emit('contact-name', { jid: result.jid, name: contactName });
            } else {
                socket.emit('error', { jid: targetJid, message: 'Number not on WhatsApp' });
            }
        } catch (err) {
            console.error('Error verifying contact:', err);
            socket.emit('error', { jid: targetJid, message: 'Verification failed' });
        }
    });

    socket.on('remove-contact', (jid: string) => {
        console.log(`Request to stop tracking: ${jid}`);
        const tracker = trackers.get(jid);
        if (tracker) {
            tracker.stopTracking();
            trackers.delete(jid);
            socket.emit('contact-removed', jid);
        }
    });
});

httpServer.listen(config.serverPort, () => {
    console.log(`Server running on port ${config.serverPort}`);
});
