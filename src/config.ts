/**
 * Configuration file for Device Activity Tracker
 *
 * Contains all configurable constants and values used throughout the application.
 * Values can be overridden via environment variables.
 *
 * Based on research methodology from:
 * "Careless Whisper: Exploiting Silent Delivery Receipts to Monitor Users on Mobile Instant Messengers"
 * by Gegenhuber et al., University of Vienna & SBA Research
 */

export interface ProbeIntervalConfig {
    min: number;    // Minimum probe interval in ms
    max: number;    // Maximum probe interval in ms
    default: number; // Default probe interval in ms
}

export interface Config {
    probeInterval: ProbeIntervalConfig;
    offlineThreshold: number;      // RTT above this indicates offline (ms)
    thresholdMultiplier: number;   // Multiplier for median RTT to calculate threshold
    globalHistoryLimit: number;    // Max measurements stored globally
    deviceHistoryLimit: number;    // Max measurements stored per device
    recentRttCount: number;        // Number of recent RTTs for moving average
    probeTimeout: number;          // Timeout for probe ACK (ms)
    serverPort: number;
    corsOrigin: string;
    clientApiUrl: string;
}

/**
 * Default configuration values
 *
 * Probe intervals based on research paper:
 * - 2 seconds: Optimal for MediaTek-based devices (Xiaomi Poco M3 Pro 5G)
 * - 20 seconds: Used for some measurement scenarios
 * - 1 minute (60000ms): Required for Samsung Galaxy S23
 */
const defaultConfig: Config = {
    probeInterval: {
        min: 50,       // 50ms - minimum for high-frequency tracking
        max: 60000,    // 1 minute - maximum per paper (Samsung Galaxy S23)
        default: 2000  // Default to 2 seconds
    },
    offlineThreshold: 10000,       // 10 seconds - RTT above this indicates offline
    thresholdMultiplier: 0.9,      // 90% of median RTT as threshold
    globalHistoryLimit: 2000,      // Store up to 2000 measurements globally
    deviceHistoryLimit: 50,        // Store up to 50 measurements per device for calibration
    recentRttCount: 3,             // Use last 3 RTTs for moving average
    probeTimeout: 10000,           // 10 seconds timeout for probe ACK
    serverPort: 3001,
    corsOrigin: process.env.CORS_ORIGIN || "*",
    clientApiUrl: process.env.REACT_APP_API_URL || "http://localhost:3001"
};

/**
 * Get configuration with environment variable overrides
 */
export function getConfig(): Config {
    return {
        probeInterval: {
            min: parseInt(process.env.PROBE_INTERVAL_MIN || String(defaultConfig.probeInterval.min), 10),
            max: parseInt(process.env.PROBE_INTERVAL_MAX || String(defaultConfig.probeInterval.max), 10),
            default: parseInt(process.env.PROBE_INTERVAL_DEFAULT || String(defaultConfig.probeInterval.default), 10)
        },
        offlineThreshold: parseInt(process.env.OFFLINE_THRESHOLD || String(defaultConfig.offlineThreshold), 10),
        thresholdMultiplier: parseFloat(process.env.THRESHOLD_MULTIPLIER || String(defaultConfig.thresholdMultiplier)),
        globalHistoryLimit: parseInt(process.env.GLOBAL_HISTORY_LIMIT || String(defaultConfig.globalHistoryLimit), 10),
        deviceHistoryLimit: parseInt(process.env.DEVICE_HISTORY_LIMIT || String(defaultConfig.deviceHistoryLimit), 10),
        recentRttCount: parseInt(process.env.RECENT_RTT_COUNT || String(defaultConfig.recentRttCount), 10),
        probeTimeout: parseInt(process.env.PROBE_TIMEOUT || String(defaultConfig.probeTimeout), 10),
        serverPort: parseInt(process.env.PORT || String(defaultConfig.serverPort), 10),
        corsOrigin: process.env.CORS_ORIGIN || defaultConfig.corsOrigin,
        clientApiUrl: process.env.REACT_APP_API_URL || defaultConfig.clientApiUrl
    };
}

// Export singleton config instance
export const config = getConfig();

