/**
 * RTT Analysis Service
 *
 * Implements a two-dimensional statistical model for device state classification:
 * - Magnitude (μ): Median RTT over sliding window → determines Online/Standby
 * - Jitter (σ): IQR (Interquartile Range) over sliding window → determines Wi-Fi/LTE
 *
 * Features:
 * - Decoupled confirmation: activity and network type are confirmed independently
 * - Confidence-based classification: fixed threshold at low confidence, adaptive P75 at high
 * - Transition detection: tracks state changes to build confidence
 * - Outlier filtering: uses 3x IQR to exclude extreme spikes from threshold calculations
 *
 * Based on research methodology from "Careless Whisper" paper.
 */

import { config } from '../config';

/** Activity states based on RTT magnitude */
export type ActivityState = 'Online' | 'Standby' | 'Offline' | 'Calibrating';

/** Network type inferred from RTT jitter */
export type NetworkType = 'Wi-Fi' | 'LTE' | 'Unknown';

/** Confidence level for activity classification */
export type ConfidenceLevel = 'Low' | 'Medium' | 'High';

/**
 * Result of state analysis with two-dimensional classification
 */
export interface StateAnalysisResult {
    // Confirmed state (after confirmation period)
    activityState: ActivityState;
    networkType: NetworkType;
    // Raw/immediate state (before confirmation)
    rawActivityState: ActivityState;
    rawNetworkType: NetworkType;
    // Window statistics
    windowMedian: number;       // Current window μ (magnitude)
    windowJitter: number;       // Current window σ (IQR-based jitter)
    magnitudeThreshold: number; // Current threshold for μ (fixed or adaptive)
    jitterThreshold: number;    // Adaptive P75 threshold for σ
    // Activity confirmation info (decoupled)
    activityPending: boolean;
    activityProgress: number;
    // Network confirmation info (decoupled)
    networkPending: boolean;
    networkProgress: number;
    // Confidence info
    confidenceLevel: ConfidenceLevel;
    observedTransitions: number;
}

/**
 * RTT Analyzer service for processing RTT measurements
 * 
 * Classification Logic:
 * - Low μ + Low σ → Online / Wi-Fi
 * - Low μ + High σ → Online / LTE
 * - High μ + Low σ → Standby / Wi-Fi
 * - High μ + High σ → Standby / LTE
 */
export class RttAnalyzer {
    // Raw RTT measurements (sliding window)
    private slidingWindow: number[] = [];
    
    // Historical window statistics for adaptive thresholds
    private medianHistory: number[] = [];  // μ history
    private jitterHistory: number[] = [];  // σ history
    
    // Cached thresholds
    private cachedMagnitudeThreshold: number = 0;
    private cachedJitterThreshold: number = 0;
    
    // Track when thresholds were last calculated
    private lastThresholdUpdateSize: number = 0;
    private readonly THRESHOLD_UPDATE_INTERVAL = 5;

    // Sample discarding for calibration outliers
    private discardedSampleCount: number = 0;

    // DECOUPLED confirmation tracking for Activity State
    private confirmedActivity: ActivityState = 'Calibrating';
    private pendingActivity: ActivityState | null = null;
    private activityPendingStartTime: number = 0;
    private activityWindowCount: number = 0;

    // DECOUPLED confirmation tracking for Network Type
    private confirmedNetwork: NetworkType = 'Unknown';
    private pendingNetwork: NetworkType | null = null;
    private networkPendingStartTime: number = 0;
    private networkWindowCount: number = 0;

    // Confidence and transition tracking
    private observedTransitions: number = 0;
    private lastStableMedian: number = 0;
    private transitionInProgress: boolean = false;

    /**
     * Add RTT measurement to the sliding window
     * Discards initial samples to prevent calibration outliers
     * @param rtt Round-trip time in milliseconds
     * @returns true if measurement was added, false if discarded
     */
    addMeasurement(rtt: number): boolean {
        // Only accept valid RTT values
        if (rtt <= 0 || rtt > 60000) {
            return false;
        }

        // Discard initial samples (calibration outliers)
        if (this.discardedSampleCount < config.discardInitialSamples) {
            this.discardedSampleCount++;
            return false;
        }

        this.slidingWindow.push(rtt);
        
        // Maintain sliding window size
        if (this.slidingWindow.length > config.slidingWindowSize) {
            this.slidingWindow.shift();
        }

        return true;
    }

    /**
     * Calculate the median of an array of numbers
     */
    private calculateMedian(values: number[]): number {
        if (values.length === 0) return 0;
        
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        
        return sorted.length % 2 !== 0
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Calculate a specific percentile of an array of numbers
     */
    private getPercentile(values: number[], percentile: number): number {
        if (values.length === 0) return 0;
        
        const sorted = [...values].sort((a, b) => a - b);
        const index = (percentile / 100) * (sorted.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        
        if (lower === upper) {
            return sorted[lower];
        }
        
        const fraction = index - lower;
        return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
    }

    /**
     * Calculate Interquartile Range (IQR) as a measure of jitter/dispersion
     */
    private calculateIQR(values: number[]): number {
        if (values.length < 4) return 0;
        
        const q1 = this.getPercentile(values, 25);
        const q3 = this.getPercentile(values, 75);
        
        return q3 - q1;
    }

    /**
     * Check if a value is an extreme outlier using 3x IQR
     */
    private isExtremeOutlier(value: number, history: number[]): boolean {
        if (history.length < 10) return false;
        
        const q1 = this.getPercentile(history, 25);
        const q3 = this.getPercentile(history, 75);
        const iqr = q3 - q1;
        const upperBound = q3 + 3 * iqr;
        
        return value > upperBound;
    }

    /**
     * Calculate current window statistics (median and jitter)
     */
    private calculateWindowStats(): { median: number; jitter: number } | null {
        if (this.slidingWindow.length < config.minSamplesForJitter) {
            return null;
        }
        
        return {
            median: this.calculateMedian(this.slidingWindow),
            jitter: this.calculateIQR(this.slidingWindow)
        };
    }

    /**
     * Detect state transitions based on median changes
     */
    private detectTransition(currentMedian: number): void {
        if (this.lastStableMedian === 0) {
            this.lastStableMedian = currentMedian;
            return;
        }

        const changePercent = Math.abs(currentMedian - this.lastStableMedian) / this.lastStableMedian * 100;

        if (changePercent >= config.transitionThresholdPercent) {
            if (!this.transitionInProgress) {
                this.transitionInProgress = true;
            }
        } else if (this.transitionInProgress) {
            this.observedTransitions++;
            this.lastStableMedian = currentMedian;
            this.transitionInProgress = false;
        }
    }

    /**
     * Get current confidence level based on observed transitions
     */
    getConfidenceLevel(): ConfidenceLevel {
        if (this.observedTransitions >= config.highConfidenceTransitions) {
            return 'High';
        }
        if (this.observedTransitions >= config.mediumConfidenceTransitions) {
            return 'Medium';
        }
        return 'Low';
    }

    /**
     * Get the effective magnitude threshold based on confidence level
     */
    private getEffectiveMagnitudeThreshold(): number {
        const confidence = this.getConfidenceLevel();
        if ((confidence === 'Medium' || confidence === 'High') && this.cachedMagnitudeThreshold > 0) {
            return this.cachedMagnitudeThreshold;
        }
        return config.fixedMagnitudeThreshold;
    }

    /**
     * Update adaptive thresholds based on historical statistics
     */
    private updateAdaptiveThresholds(): void {
        if (this.medianHistory.length < config.minSamplesForJitter) {
            return;
        }
        
        const shouldUpdate = 
            this.medianHistory.length - this.lastThresholdUpdateSize >= this.THRESHOLD_UPDATE_INTERVAL ||
            this.cachedMagnitudeThreshold === 0;
        
        if (shouldUpdate) {
            this.cachedMagnitudeThreshold = this.getPercentile(
                this.medianHistory, 
                config.magnitudePercentile
            );
            this.cachedJitterThreshold = this.getPercentile(
                this.jitterHistory, 
                config.jitterPercentile
            );
            this.lastThresholdUpdateSize = this.medianHistory.length;
        }
    }

    /**
     * Check if pending activity should be confirmed
     */
    private shouldConfirmActivity(): boolean {
        if (!this.pendingActivity) return false;
        const elapsedSeconds = (Date.now() - this.activityPendingStartTime) / 1000;
        return this.activityWindowCount >= config.stateConfirmationWindows &&
               elapsedSeconds >= config.stateConfirmationSeconds;
    }

    /**
     * Check if pending network should be confirmed
     */
    private shouldConfirmNetwork(): boolean {
        if (!this.pendingNetwork) return false;
        const elapsedSeconds = (Date.now() - this.networkPendingStartTime) / 1000;
        return this.networkWindowCount >= config.stateConfirmationWindows &&
               elapsedSeconds >= config.stateConfirmationSeconds;
    }

    /**
     * Get activity confirmation progress (0-100)
     */
    private getActivityProgress(): number {
        if (!this.pendingActivity) return 0;
        const windowProgress = Math.min((this.activityWindowCount / config.stateConfirmationWindows) * 100, 100);
        const elapsedSeconds = (Date.now() - this.activityPendingStartTime) / 1000;
        const timeProgress = Math.min((elapsedSeconds / config.stateConfirmationSeconds) * 100, 100);
        return Math.min(windowProgress, timeProgress);
    }

    /**
     * Get network confirmation progress (0-100)
     */
    private getNetworkProgress(): number {
        if (!this.pendingNetwork) return 0;
        const windowProgress = Math.min((this.networkWindowCount / config.stateConfirmationWindows) * 100, 100);
        const elapsedSeconds = (Date.now() - this.networkPendingStartTime) / 1000;
        const timeProgress = Math.min((elapsedSeconds / config.stateConfirmationSeconds) * 100, 100);
        return Math.min(windowProgress, timeProgress);
    }

    /**
     * Update ACTIVITY confirmation tracking (decoupled from network)
     */
    private updateActivityConfirmation(rawActivity: ActivityState): void {
        if (rawActivity === this.confirmedActivity) {
            // Matches confirmed - clear pending
            this.pendingActivity = null;
            this.activityWindowCount = 0;
            return;
        }

        if (rawActivity === this.pendingActivity) {
            // Matches pending - increment and check
            this.activityWindowCount++;
            if (this.shouldConfirmActivity()) {
                this.confirmedActivity = this.pendingActivity!;
                this.pendingActivity = null;
                this.activityWindowCount = 0;
            }
        } else {
            // New state - start pending
            this.pendingActivity = rawActivity;
            this.activityPendingStartTime = Date.now();
            this.activityWindowCount = 1;
        }
    }

    /**
     * Update NETWORK confirmation tracking (decoupled from activity)
     */
    private updateNetworkConfirmation(rawNetwork: NetworkType): void {
        if (rawNetwork === this.confirmedNetwork) {
            // Matches confirmed - clear pending
            this.pendingNetwork = null;
            this.networkWindowCount = 0;
            return;
        }

        if (rawNetwork === this.pendingNetwork) {
            // Matches pending - increment and check
            this.networkWindowCount++;
            if (this.shouldConfirmNetwork()) {
                this.confirmedNetwork = this.pendingNetwork!;
                this.pendingNetwork = null;
                this.networkWindowCount = 0;
            }
        } else {
            // New state - start pending
            this.pendingNetwork = rawNetwork;
            this.networkPendingStartTime = Date.now();
            this.networkWindowCount = 1;
        }
    }

    /**
     * Determine device state based on two-dimensional RTT analysis
     * Activity and Network are confirmed INDEPENDENTLY
     */
    determineState(currentState: string, isTimeout: boolean = false): StateAnalysisResult {
        // Handle offline state from timeout
        if (isTimeout) {
            // Immediately confirm offline (no delay)
            this.confirmedActivity = 'Offline';
            this.confirmedNetwork = 'Unknown';
            this.pendingActivity = null;
            this.pendingNetwork = null;
            this.activityWindowCount = 0;
            this.networkWindowCount = 0;

            return {
                activityState: 'Offline',
                networkType: 'Unknown',
                rawActivityState: 'Offline',
                rawNetworkType: 'Unknown',
                windowMedian: 0,
                windowJitter: 0,
                magnitudeThreshold: this.getEffectiveMagnitudeThreshold(),
                jitterThreshold: this.cachedJitterThreshold,
                activityPending: false,
                activityProgress: 0,
                networkPending: false,
                networkProgress: 0,
                confidenceLevel: this.getConfidenceLevel(),
                observedTransitions: this.observedTransitions
            };
        }

        // If previously offline but now getting data, reset to calibrating
        if (currentState === 'Offline' && this.confirmedActivity === 'Offline') {
            this.confirmedActivity = 'Calibrating';
            this.confirmedNetwork = 'Unknown';
        }

        // Calculate current window statistics
        const windowStats = this.calculateWindowStats();
        
        // Not enough data yet - still calibrating
        if (!windowStats) {
            return {
                activityState: 'Calibrating',
                networkType: 'Unknown',
                rawActivityState: 'Calibrating',
                rawNetworkType: 'Unknown',
                windowMedian: 0,
                windowJitter: 0,
                magnitudeThreshold: config.fixedMagnitudeThreshold,
                jitterThreshold: 0,
                activityPending: false,
                activityProgress: 0,
                networkPending: false,
                networkProgress: 0,
                confidenceLevel: 'Low',
                observedTransitions: 0
            };
        }

        // Detect transitions for confidence tracking
        this.detectTransition(windowStats.median);

        // Add to history only if not an extreme outlier
        if (!this.isExtremeOutlier(windowStats.median, this.medianHistory)) {
            this.medianHistory.push(windowStats.median);
        }
        this.jitterHistory.push(windowStats.jitter);
        
        // Limit history size
        const maxHistorySize = config.globalHistoryLimit;
        if (this.medianHistory.length > maxHistorySize) {
            this.medianHistory.shift();
        }
        if (this.jitterHistory.length > maxHistorySize) {
            this.jitterHistory.shift();
        }

        // Update adaptive thresholds
        this.updateAdaptiveThresholds();

        // Get effective threshold based on confidence level
        const effectiveThreshold = this.getEffectiveMagnitudeThreshold();

        // Two-dimensional classification (raw/immediate)
        const isHighMagnitude = windowStats.median >= effectiveThreshold;
        const isHighJitter = this.cachedJitterThreshold > 0 
            ? windowStats.jitter >= this.cachedJitterThreshold
            : false;

        const rawActivityState: ActivityState = isHighMagnitude ? 'Standby' : 'Online';
        const rawNetworkType: NetworkType = isHighJitter ? 'LTE' : 'Wi-Fi';

        // Update DECOUPLED confirmation tracking
        this.updateActivityConfirmation(rawActivityState);
        this.updateNetworkConfirmation(rawNetworkType);

        // First valid classification - set initial confirmed states
        if (this.confirmedActivity === 'Calibrating') {
            this.confirmedActivity = rawActivityState;
        }
        if (this.confirmedNetwork === 'Unknown' && this.cachedJitterThreshold > 0) {
            this.confirmedNetwork = rawNetworkType;
        }

        return {
            activityState: this.confirmedActivity,
            networkType: this.confirmedNetwork,
            rawActivityState,
            rawNetworkType,
            windowMedian: windowStats.median,
            windowJitter: windowStats.jitter,
            magnitudeThreshold: effectiveThreshold,
            jitterThreshold: this.cachedJitterThreshold,
            activityPending: this.pendingActivity !== null,
            activityProgress: this.getActivityProgress(),
            networkPending: this.pendingNetwork !== null,
            networkProgress: this.getNetworkProgress(),
            confidenceLevel: this.getConfidenceLevel(),
            observedTransitions: this.observedTransitions
        };
    }

    getWindowSize(): number {
        return this.slidingWindow.length;
    }

    getDiscardedCount(): number {
        return this.discardedSampleCount;
    }

    getHistorySize(): number {
        return this.medianHistory.length;
    }

    getObservedTransitions(): number {
        return this.observedTransitions;
    }

    getMagnitudeThreshold(): number {
        return this.cachedMagnitudeThreshold;
    }

    getEffectiveThreshold(): number {
        return this.getEffectiveMagnitudeThreshold();
    }

    getJitterThreshold(): number {
        return this.cachedJitterThreshold;
    }

    getSlidingWindow(): number[] {
        return [...this.slidingWindow];
    }

    reset(): void {
        this.slidingWindow = [];
        this.medianHistory = [];
        this.jitterHistory = [];
        this.cachedMagnitudeThreshold = 0;
        this.cachedJitterThreshold = 0;
        this.lastThresholdUpdateSize = 0;
        this.discardedSampleCount = 0;
        this.confirmedActivity = 'Calibrating';
        this.confirmedNetwork = 'Unknown';
        this.pendingActivity = null;
        this.pendingNetwork = null;
        this.activityPendingStartTime = 0;
        this.networkPendingStartTime = 0;
        this.activityWindowCount = 0;
        this.networkWindowCount = 0;
        this.observedTransitions = 0;
        this.lastStableMedian = 0;
        this.transitionInProgress = false;
    }
}
