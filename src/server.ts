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
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { Boom } from '@hapi/boom';
import { WhatsAppTracker, ProbeMethod } from './tracker';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Allow all origins for dev
        methods: ["GET", "POST"]
    }
});

let sock: any;
let isWhatsAppConnected = false;
let globalProbeMethod: ProbeMethod = 'delete'; // Default to delete method
const trackers: Map<string, WhatsAppTracker> = new Map(); // JID -> Tracker instance

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'debug' }),
        markOnlineOnConnect: true,
        printQRInTerminal: false,
    });

    sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code generated');
            io.emit('qr', qr);
        }

        if (connection === 'close') {
            isWhatsAppConnected = false;
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed, reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isWhatsAppConnected = true;
            console.log('opened connection');
            io.emit('connection-open');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }: any) => {
        console.log(`[SESSION] History sync - Chats: ${chats.length}, Contacts: ${contacts.length}, Messages: ${messages.length}, Latest: ${isLatest}`);
    });

    sock.ev.on('messages.update', (updates: any) => {
        for (const update of updates) {
            console.log(`[MSG UPDATE] JID: ${update.key.remoteJid}, ID: ${update.key.id}, Status: ${update.update.status}, FromMe: ${update.key.fromMe}`);
        }
    });
}

connectToWhatsApp();

io.on('connection', (socket) => {
    console.log('Client connected');

    if (isWhatsAppConnected) {
        socket.emit('connection-open');
    }

    // Send current probe method to client
    socket.emit('probe-method', globalProbeMethod);

    socket.emit('tracked-contacts', Array.from(trackers.keys()));

    socket.on('add-contact', async (number: string) => {
        console.log(`Request to track: ${number}`);
        const cleanNumber = number.replace(/\D/g, '');
        const targetJid = cleanNumber + '@s.whatsapp.net';

        if (trackers.has(targetJid)) {
            socket.emit('error', { jid: targetJid, message: 'Already tracking this contact' });
            return;
        }

        try {
            const results = await sock.onWhatsApp(targetJid);
            const result = results?.[0];

            if (result?.exists) {
                const tracker = new WhatsAppTracker(sock, result.jid);
                tracker.setProbeMethod(globalProbeMethod); // Use current global method
                trackers.set(result.jid, tracker);

                tracker.onUpdate = (data) => {
                    io.emit('tracker-update', {
                        jid: result.jid,
                        ...data
                    });
                };

                tracker.startTracking();

                const ppUrl = await tracker.getProfilePicture();

                let contactName = cleanNumber;
                try {
                    const contactInfo = await sock.onWhatsApp(result.jid);
                    if (contactInfo && contactInfo[0]?.notify) {
                        contactName = contactInfo[0].notify;
                    }
                } catch (err) {
                    console.log('[NAME] Could not fetch contact name, using number');
                }

                socket.emit('contact-added', { jid: result.jid, number: cleanNumber });

                io.emit('profile-pic', { jid: result.jid, url: ppUrl });
                io.emit('contact-name', { jid: result.jid, name: contactName });
            } else {
                socket.emit('error', { jid: targetJid, message: 'Number not on WhatsApp' });
            }
        } catch (err) {
            console.error(err);
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

    socket.on('set-probe-method', (method: ProbeMethod) => {
        console.log(`Request to change probe method to: ${method}`);
        if (method !== 'delete' && method !== 'reaction') {
            socket.emit('error', { message: 'Invalid probe method' });
            return;
        }

        globalProbeMethod = method;

        for (const tracker of trackers.values()) {
            tracker.setProbeMethod(method);
        }

        io.emit('probe-method', method);
        console.log(`Probe method changed to: ${method}`);
    });
});

const PORT = 3001;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
