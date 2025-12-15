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
    globalHistoryLimit: number;    // Max measurements stored globally
    deviceHistoryLimit: number;    // Max measurements stored per device
    probeTimeout: number;          // Timeout for probe ACK (ms)
    // Statistical classification settings
    slidingWindowSize: number;     // Number of samples for μ/σ calculation
    magnitudePercentile: number;   // Percentile for "high" magnitude threshold (e.g., 75 = P75)
    jitterPercentile: number;      // Percentile for "high" jitter threshold (e.g., 75 = P75)
    minSamplesForJitter: number;   // Minimum samples before jitter calculation is reliable
    // State change confirmation settings
    stateConfirmationWindows: number;  // Require N consecutive windows in new state
    stateConfirmationSeconds: number;  // AND minimum N seconds in new state
    discardInitialSamples: number;     // Discard first N samples during calibration
    // Confidence system settings
    mediumConfidenceTransitions: number;    // Transitions needed for medium confidence
    highConfidenceTransitions: number;      // Transitions needed for high confidence
    transitionThresholdPercent: number;     // Median change % to count as transition
    fixedMagnitudeThreshold: number;        // RTT >= this = Standby (low confidence mode)
    // Server settings
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
    globalHistoryLimit: 2000,      // Store up to 2000 measurements globally
    deviceHistoryLimit: 50,        // Store up to 50 measurements per device for calibration
    probeTimeout: 10000,           // 10 seconds timeout for probe ACK
    // Statistical classification - based on two-dimensional model (magnitude + jitter)
    slidingWindowSize: 20,         // 20 samples for calculating window median and IQR
    magnitudePercentile: 75,       // P75 = threshold for "high" RTT magnitude
    jitterPercentile: 75,          // P75 = threshold for "high" RTT jitter
    minSamplesForJitter: 5,        // Need at least 5 samples for reliable IQR
    // State change confirmation - prevents rapid status flipping
    stateConfirmationWindows: 3,   // Require 3 consecutive windows in new state
    stateConfirmationSeconds: 5,   // AND minimum 5 seconds in new state
    discardInitialSamples: 5,      // Discard first 5 samples (outliers during calibration)
    // Confidence system - uses fixed threshold until transitions are observed
    mediumConfidenceTransitions: 2,     // Need 2 transitions for medium confidence (minimum)
    highConfidenceTransitions: 4,       // Need 4 transitions for high confidence (clear pattern)
    transitionThresholdPercent: 25,     // Median change >= 25% = transition (more sensitive)
    fixedMagnitudeThreshold: 800,       // RTT >= 800ms = Standby (low confidence)
    // Server settings
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
        globalHistoryLimit: parseInt(process.env.GLOBAL_HISTORY_LIMIT || String(defaultConfig.globalHistoryLimit), 10),
        deviceHistoryLimit: parseInt(process.env.DEVICE_HISTORY_LIMIT || String(defaultConfig.deviceHistoryLimit), 10),
        probeTimeout: parseInt(process.env.PROBE_TIMEOUT || String(defaultConfig.probeTimeout), 10),
        // Statistical classification settings
        slidingWindowSize: parseInt(process.env.SLIDING_WINDOW_SIZE || String(defaultConfig.slidingWindowSize), 10),
        magnitudePercentile: parseInt(process.env.MAGNITUDE_PERCENTILE || String(defaultConfig.magnitudePercentile), 10),
        jitterPercentile: parseInt(process.env.JITTER_PERCENTILE || String(defaultConfig.jitterPercentile), 10),
        minSamplesForJitter: parseInt(process.env.MIN_SAMPLES_FOR_JITTER || String(defaultConfig.minSamplesForJitter), 10),
        // State change confirmation settings
        stateConfirmationWindows: parseInt(process.env.STATE_CONFIRMATION_WINDOWS || String(defaultConfig.stateConfirmationWindows), 10),
        stateConfirmationSeconds: parseInt(process.env.STATE_CONFIRMATION_SECONDS || String(defaultConfig.stateConfirmationSeconds), 10),
        discardInitialSamples: parseInt(process.env.DISCARD_INITIAL_SAMPLES || String(defaultConfig.discardInitialSamples), 10),
        // Confidence system settings
        mediumConfidenceTransitions: parseInt(process.env.MEDIUM_CONFIDENCE_TRANSITIONS || String(defaultConfig.mediumConfidenceTransitions), 10),
        highConfidenceTransitions: parseInt(process.env.HIGH_CONFIDENCE_TRANSITIONS || String(defaultConfig.highConfidenceTransitions), 10),
        transitionThresholdPercent: parseInt(process.env.TRANSITION_THRESHOLD_PERCENT || String(defaultConfig.transitionThresholdPercent), 10),
        fixedMagnitudeThreshold: parseInt(process.env.FIXED_MAGNITUDE_THRESHOLD || String(defaultConfig.fixedMagnitudeThreshold), 10),
        // Server settings
        serverPort: parseInt(process.env.PORT || String(defaultConfig.serverPort), 10),
        corsOrigin: process.env.CORS_ORIGIN || defaultConfig.corsOrigin,
        clientApiUrl: process.env.REACT_APP_API_URL || defaultConfig.clientApiUrl
    };
}

// Export singleton config instance
export const config = getConfig();

