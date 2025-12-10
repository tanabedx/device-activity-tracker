import '@whiskeysockets/baileys';
import { WASocket, proto } from '@whiskeysockets/baileys';
import { config } from './config';
import { RttAnalyzer, StateAnalysisResult } from './services/rttAnalyzer';

/**
 * Logger utility for debug and normal mode
 */
class TrackerLogger {
    private isDebugMode: boolean;

    constructor(debugMode: boolean = false) {
        this.isDebugMode = debugMode;
    }

    setDebugMode(enabled: boolean) {
        this.isDebugMode = enabled;
    }

    debug(...args: unknown[]) {
        if (this.isDebugMode) {
            console.log(...args);
        }
    }

    info(...args: unknown[]) {
        console.log(...args);
    }

    error(...args: unknown[]) {
        console.error(...args);
    }

    formatDeviceState(jid: string, rtt: number, avgRtt: number, median: number, threshold: number, state: string) {
        const stateColor = state === 'Online' ? '🟢' : state === 'Standby' ? '🟡' : state === 'OFFLINE' ? '🔴' : '⚪';
        const timestamp = new Date().toLocaleTimeString('en-US');

        console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
        console.log(`║ ${stateColor} Device Status Update - ${timestamp}                 ║`);
        console.log(`╠════════════════════════════════════════════════════════════════╣`);
        console.log(`║ JID:        ${jid.padEnd(48)} ║`);
        console.log(`║ Status:     ${state.padEnd(48)} ║`);
        console.log(`║ RTT:        ${rtt}ms${' '.repeat(48 - (rtt.toString().length + 2))}║`);
        console.log(`║ Avg (3):    ${avgRtt.toFixed(0)}ms${' '.repeat(48 - (avgRtt.toFixed(0).length + 2))}║`);
        console.log(`║ Median:     ${median.toFixed(0)}ms${' '.repeat(48 - (median.toFixed(0).length + 2))}║`);
        console.log(`║ Threshold:  ${threshold.toFixed(0)}ms${' '.repeat(48 - (threshold.toFixed(0).length + 2))}║`);
        console.log(`╚════════════════════════════════════════════════════════════════╝\n`);
    }
}

const trackerLogger = new TrackerLogger();

/**
 * Metrics tracked per device for activity monitoring
 */
interface DeviceMetrics {
    rttHistory: number[];      // Historical RTT measurements (up to deviceHistoryLimit)
    recentRtts: number[];      // Recent RTTs for moving average (last recentRttCount)
    state: string;             // Current device state (Online/Standby/Calibrating/OFFLINE)
    lastRtt: number;           // Most recent RTT measurement
    lastUpdate: number;        // Timestamp of last update
    consecutiveTimeouts: number; // Track consecutive timeouts for offline detection
}

/**
 * WhatsAppTracker - Monitors messaging app user activity using RTT-based analysis
 *
 * This class implements a privacy research proof-of-concept that demonstrates
 * how messaging apps can leak user activity information through network timing.
 *
 * The tracker sends probe messages and measures Round-Trip Time (RTT) to detect
 * when a user's device is actively in use vs. in standby mode.
 *
 * Works with WhatsApp, Signal, and similar messaging platforms.
 *
 * Based on research: "Careless Whisper: Exploiting Silent Delivery Receipts to Monitor Users"
 * by Gegenhuber et al., University of Vienna & SBA Research
 */
export class WhatsAppTracker {
    private sock: WASocket;
    private targetJid: string;
    private trackedJids: Set<string> = new Set(); // Multi-device support
    private isTracking: boolean = false;
    private deviceMetrics: Map<string, DeviceMetrics> = new Map();
    private rttAnalyzer: RttAnalyzer; // Use centralized RTT analyzer
    private probeStartTimes: Map<string, number> = new Map();
    private probeTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private lastPresence: string | null = null;
    public onUpdate?: (data: unknown) => void;

    // Store event listener references for cleanup
    private messagesUpdateListener: ((updates: { key: proto.IMessageKey, update: Partial<proto.IWebMessageInfo> }[]) => void) | null = null;
    private presenceUpdateListener: ((update: { id: string, presences: { [participant: string]: { lastKnownPresence: string } } }) => void) | null = null;

    constructor(sock: WASocket, targetJid: string, debugMode: boolean = false) {
        this.sock = sock;
        this.targetJid = targetJid;
        this.trackedJids.add(targetJid);
        this.rttAnalyzer = new RttAnalyzer();
        trackerLogger.setDebugMode(debugMode);
    }

    /**
     * Start tracking the target user's activity
     * Sets up event listeners for message receipts and presence updates
     */
    public async startTracking() {
        if (this.isTracking) return;
        this.isTracking = true;
        trackerLogger.info(`\n✅ Tracking started for ${this.targetJid}\n`);

        // Create and store event listener references for cleanup
        this.messagesUpdateListener = (updates) => {
            for (const update of updates) {
                // Check if update is from any of the tracked JIDs (multi-device support)
                if (update.key.remoteJid && this.trackedJids.has(update.key.remoteJid) && update.key.fromMe) {
                    this.analyzeUpdate(update);
                }
            }
        };

        this.presenceUpdateListener = (update) => {
            trackerLogger.debug('[PRESENCE] Raw update received:', JSON.stringify(update, null, 2));

            if (update.presences) {
                for (const [jid, presenceData] of Object.entries(update.presences)) {
                    if (presenceData && presenceData.lastKnownPresence) {
                        // Track multi-device JIDs (including LID)
                        this.trackedJids.add(jid);
                        trackerLogger.debug(`[MULTI-DEVICE] Added JID to tracking: ${jid}`);

                        this.lastPresence = presenceData.lastKnownPresence;
                        trackerLogger.debug(`[PRESENCE] Stored presence from ${jid}: ${this.lastPresence}`);
                        break;
                    }
                }
            }
        };

        // Listen for message updates (receipts)
        this.sock.ev.on('messages.update', this.messagesUpdateListener);

        // Listen for presence updates
        this.sock.ev.on('presence.update', this.presenceUpdateListener);

        // Subscribe to presence updates
        try {
            await this.sock.presenceSubscribe(this.targetJid);
            trackerLogger.debug(`[PRESENCE] Successfully subscribed to presence for ${this.targetJid}`);
            trackerLogger.debug(`[MULTI-DEVICE] Currently tracking JIDs: ${Array.from(this.trackedJids).join(', ')}`);
        } catch (err) {
            trackerLogger.debug('[PRESENCE] Error subscribing to presence:', err);
        }

        // Send initial state update
        if (this.onUpdate) {
            this.onUpdate({
                devices: [],
                deviceCount: this.trackedJids.size,
                presence: this.lastPresence,
                median: 0,
                threshold: 0
            });
        }

        // Start the probe loop
        this.probeLoop();
    }

    private async probeLoop() {
        while (this.isTracking) {
            try {
                await this.sendProbe();
            } catch (err) {
                trackerLogger.error('[PROBE ERROR] Error in probe loop:', err);
            }
            // Add jitter to probe interval to avoid detection patterns
            const jitter = Math.floor(Math.random() * 100);
            const delay = config.probeInterval.default + jitter;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    /**
     * Send a probe message to measure RTT
     * Uses a reaction to a non-existent message to minimize user disruption
     */
    private async sendProbe() {
        try {
            // Generate a random message ID that likely doesn't exist
            const prefixes = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];
            const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
            const randomMsgId = randomPrefix + randomSuffix;

            // Randomize reaction emoji
            const reactions = ['👍', '❤️', '😂', '😮', '😢', '🙏', '👻', '🔥', '✨', ''];
            const randomReaction = reactions[Math.floor(Math.random() * reactions.length)];

            const reactionMessage = {
                react: {
                    text: randomReaction,
                    key: {
                        remoteJid: this.targetJid,
                        fromMe: false,
                        id: randomMsgId
                    }
                }
            };

            trackerLogger.debug(`[PROBE] Sending probe with reaction "${randomReaction}" to non-existent message ${randomMsgId}`);
            const result = await this.sock.sendMessage(this.targetJid, reactionMessage);
            const startTime = Date.now();

            if (result?.key?.id) {
                trackerLogger.debug(`[PROBE] Probe sent successfully, message ID: ${result.key.id}`);
                this.probeStartTimes.set(result.key.id, startTime);

                // Set timeout: if no CLIENT ACK within timeout, mark device as OFFLINE
                const timeoutId = setTimeout(() => {
                    if (this.probeStartTimes.has(result.key.id!)) {
                        const elapsedTime = Date.now() - startTime;
                        trackerLogger.debug(`[PROBE TIMEOUT] No CLIENT ACK for ${result.key.id} after ${elapsedTime}ms`);
                        this.probeStartTimes.delete(result.key.id!);
                        this.probeTimeouts.delete(result.key.id!);

                        // Mark device as potentially offline due to no response
                        if (result.key.remoteJid) {
                            this.handleProbeTimeout(result.key.remoteJid, elapsedTime);
                        }
                    }
                }, config.probeTimeout);

                this.probeTimeouts.set(result.key.id, timeoutId);
            } else {
                trackerLogger.debug('[PROBE ERROR] Failed to get message ID from send result');
            }
        } catch (err) {
            trackerLogger.error('[PROBE ERROR] Failed to send probe message:', err);
        }
    }

    /**
     * Analyze message update and calculate RTT
     * @param update Message update from WhatsApp
     */
    private analyzeUpdate(update: { key: proto.IMessageKey, update: Partial<proto.IWebMessageInfo> }) {
        const status = update.update.status;
        const msgId = update.key.id;
        const fromJid = update.key.remoteJid;

        if (!msgId || !fromJid) return;

        trackerLogger.debug(`[TRACKING] Message Update - ID: ${msgId}, JID: ${fromJid}, Status: ${status} (${this.getStatusName(status)})`);

        // Only CLIENT ACK (3) means device is online and received the message
        // SERVER ACK (2) only means server received it, not the device
        if (status === 3) { // CLIENT ACK
            const startTime = this.probeStartTimes.get(msgId);

            if (startTime) {
                const rtt = Date.now() - startTime;
                trackerLogger.debug(`[TRACKING] ✅ CLIENT ACK received for ${msgId} from ${fromJid}, RTT: ${rtt}ms`);

                // Clear timeout
                const timeoutId = this.probeTimeouts.get(msgId);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    this.probeTimeouts.delete(msgId);
                }

                this.probeStartTimes.delete(msgId);
                this.addMeasurementForDevice(fromJid, rtt);
            } else {
                trackerLogger.debug(`[TRACKING] ⚠️ CLIENT ACK for ${msgId} from ${fromJid} but no start time found (not our probe or already processed)`);
            }
        }
    }

    private getStatusName(status: number | null | undefined): string {
        switch (status) {
            case 0: return 'ERROR';
            case 1: return 'PENDING';
            case 2: return 'SERVER_ACK';
            case 3: return 'DELIVERY_ACK';
            case 4: return 'READ';
            case 5: return 'PLAYED';
            default: return 'UNKNOWN';
        }
    }

    /**
     * Handle probe timeout - improved offline detection
     * Uses consecutive timeout tracking for more reliable offline detection
     * @param jid Device JID
     * @param timeout Time elapsed before timeout
     */
    private handleProbeTimeout(jid: string, timeout: number) {
        // Initialize device metrics if not exists
        if (!this.deviceMetrics.has(jid)) {
            this.deviceMetrics.set(jid, {
                rttHistory: [],
                recentRtts: [],
                state: 'Calibrating...',
                lastRtt: timeout,
                lastUpdate: Date.now(),
                consecutiveTimeouts: 1
            });
        } else {
            const metrics = this.deviceMetrics.get(jid)!;
            metrics.consecutiveTimeouts++;
            metrics.lastRtt = timeout;
            metrics.lastUpdate = Date.now();

            // Only mark as OFFLINE after multiple consecutive timeouts
            // This prevents false positives from network hiccups
            if (metrics.consecutiveTimeouts >= 3) {
                metrics.state = 'OFFLINE';
                trackerLogger.info(`\n🔴 Device ${jid} marked as OFFLINE (${metrics.consecutiveTimeouts} consecutive timeouts)\n`);
            } else {
                trackerLogger.debug(`[DEVICE ${jid}] Timeout ${metrics.consecutiveTimeouts}/3 - not marking offline yet`);
            }
        }

        this.sendUpdate();
    }

    /**
     * Add RTT measurement for a specific device and update its state
     * @param jid Device JID
     * @param rtt Round-trip time in milliseconds
     */
    private addMeasurementForDevice(jid: string, rtt: number) {
        // Initialize device metrics if not exists
        if (!this.deviceMetrics.has(jid)) {
            this.deviceMetrics.set(jid, {
                rttHistory: [],
                recentRtts: [],
                state: 'Calibrating...',
                lastRtt: rtt,
                lastUpdate: Date.now(),
                consecutiveTimeouts: 0
            });
        }

        const metrics = this.deviceMetrics.get(jid)!;

        // Reset consecutive timeouts since we got a response
        metrics.consecutiveTimeouts = 0;

        // Only process measurements within reasonable range
        if (rtt <= config.offlineThreshold) {
            // 1. Add to device's recent RTTs for moving average
            metrics.recentRtts.push(rtt);
            if (metrics.recentRtts.length > config.recentRttCount) {
                metrics.recentRtts.shift();
            }

            // 2. Add to device's history for calibration
            metrics.rttHistory.push(rtt);
            if (metrics.rttHistory.length > config.deviceHistoryLimit) {
                metrics.rttHistory.shift();
            }

            // 3. Add to global RTT analyzer
            this.rttAnalyzer.addMeasurement(rtt);

            metrics.lastRtt = rtt;
            metrics.lastUpdate = Date.now();

            // Determine new state based on RTT using the analyzer
            this.determineDeviceState(jid);
        } else {
            // High RTT but got a response - device is slow but not offline
            trackerLogger.debug(`[DEVICE ${jid}] High RTT (${rtt}ms) but device responded - marking as Standby`);
            metrics.state = 'Standby';
            metrics.lastRtt = rtt;
            metrics.lastUpdate = Date.now();
        }

        this.sendUpdate();
    }

    /**
     * Determine device state (Online/Standby/OFFLINE) based on RTT analysis
     * Uses the centralized RttAnalyzer for efficient cached calculations
     * @param jid Device JID
     */
    private determineDeviceState(jid: string) {
        const metrics = this.deviceMetrics.get(jid);
        if (!metrics) return;

        // Use the RTT analyzer to determine state
        const analysis: StateAnalysisResult = this.rttAnalyzer.determineState(
            metrics.recentRtts,
            metrics.lastRtt,
            metrics.state
        );

        metrics.state = analysis.state;

        // Normal mode: Formatted output
        trackerLogger.formatDeviceState(
            jid,
            metrics.lastRtt,
            analysis.movingAvg,
            analysis.median,
            analysis.threshold,
            metrics.state
        );

        // Debug mode: Additional debug information
        trackerLogger.debug(`[DEBUG] RTT History length: ${metrics.rttHistory.length}, Global History: ${this.rttAnalyzer.getHistorySize()}`);
    }

    /**
     * Send update to client with current tracking data
     */
    private sendUpdate() {
        // Build devices array
        const devices = Array.from(this.deviceMetrics.entries()).map(([jid, metrics]) => ({
            jid,
            state: metrics.state,
            rtt: metrics.lastRtt,
            avg: metrics.recentRtts.length > 0
                ? metrics.recentRtts.reduce((a: number, b: number) => a + b, 0) / metrics.recentRtts.length
                : 0
        }));

        // Get global stats from analyzer
        const globalMedian = this.rttAnalyzer.getCachedMedian() || this.rttAnalyzer.calculateMedian();
        const globalThreshold = this.rttAnalyzer.getCachedThreshold() || this.rttAnalyzer.calculateThreshold();

        const data = {
            devices,
            deviceCount: this.trackedJids.size,
            presence: this.lastPresence,
            // Global stats for charts
            median: globalMedian,
            threshold: globalThreshold
        };

        if (this.onUpdate) {
            this.onUpdate(data);
        }
    }

    /**
     * Get profile picture URL for the target user
     * @returns Profile picture URL or null if not available
     */
    public async getProfilePicture() {
        try {
            return await this.sock.profilePictureUrl(this.targetJid, 'image');
        } catch {
            return null;
        }
    }

    /**
     * Stop tracking and clean up resources
     * Properly removes event listeners to prevent memory leaks
     */
    public stopTracking() {
        this.isTracking = false;

        // Remove event listeners to prevent memory leaks
        if (this.messagesUpdateListener) {
            this.sock.ev.off('messages.update', this.messagesUpdateListener);
            this.messagesUpdateListener = null;
        }

        if (this.presenceUpdateListener) {
            this.sock.ev.off('presence.update', this.presenceUpdateListener);
            this.presenceUpdateListener = null;
        }

        // Clear all pending timeouts
        for (const timeoutId of this.probeTimeouts.values()) {
            clearTimeout(timeoutId);
        }
        this.probeTimeouts.clear();
        this.probeStartTimes.clear();

        // Reset the RTT analyzer
        this.rttAnalyzer.reset();

        trackerLogger.info(`\n⏹️ Tracking stopped for ${this.targetJid}\n`);
    }
}
