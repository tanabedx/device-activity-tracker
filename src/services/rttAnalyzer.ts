/**
 * RTT Analysis Service
 *
 * Extracted RTT analysis logic for better separation of concerns.
 * Handles median calculation, threshold computation, and state determination
 * based on RTT measurements.
 *
 * Based on research methodology from "Careless Whisper" paper.
 */

import { config } from '../config';

export interface StateAnalysisResult {
    median: number;
    threshold: number;
    state: string;
    movingAvg: number;
}

/**
 * RTT Analyzer service for processing RTT measurements
 */
export class RttAnalyzer {
    private globalRttHistory: number[] = [];
    private cachedMedian: number = 0;
    private cachedThreshold: number = 0;
    private lastCalculationSize: number = 0;
    private readonly RECALCULATION_INTERVAL = 10; // Recalculate every 10 measurements

    /**
     * Add RTT measurement to global history
     * @param rtt Round-trip time in milliseconds
     */
    addMeasurement(rtt: number): void {
        // Add all valid RTTs to history, even if above offline threshold
        // This allows us to calculate median/threshold even when some values are high
        // We'll still mark devices as offline if RTT > threshold, but we need the data for calculation
        if (rtt > 0 && rtt <= 60000) { // Allow up to 60 seconds
            this.globalRttHistory.push(rtt);
            if (this.globalRttHistory.length > config.globalHistoryLimit) {
                this.globalRttHistory.shift();
            }
        }
    }

    /**
     * Calculate global median RTT
     * Recalculates if cache is stale or if forced
     * @param forceRecalculate Force recalculation even if cache exists
     * @returns Median RTT value
     */
    calculateMedian(forceRecalculate: boolean = false): number {
        if (this.globalRttHistory.length < config.recentRttCount) return 0;

        // Check if cache is stale (new measurements added since last calculation)
        const isCacheStale = this.globalRttHistory.length !== this.lastCalculationSize;

        // Use cached value only if cache is valid and not forced to recalculate
        if (!forceRecalculate && !isCacheStale && this.cachedMedian > 0 && this.lastCalculationSize > 0) {
            return this.cachedMedian;
        }

        // Recalculate median
        const sorted = [...this.globalRttHistory].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

        // Update cache
        this.cachedMedian = median;
        this.cachedThreshold = median * config.thresholdMultiplier;
        this.lastCalculationSize = this.globalRttHistory.length;

        return median;
    }

    /**
     * Calculate threshold based on median
     * Recalculates if cache is stale or if forced
     * @param forceRecalculate Force recalculation even if cache exists
     * @returns Threshold value (percentage of median)
     */
    calculateThreshold(forceRecalculate: boolean = false): number {
        const median = this.calculateMedian(forceRecalculate);

        // Check if cache is stale
        const isCacheStale = this.globalRttHistory.length !== this.lastCalculationSize;

        // Use cached threshold only if cache is valid and not forced to recalculate
        if (!forceRecalculate && !isCacheStale && this.cachedThreshold > 0 && this.lastCalculationSize > 0) {
            return this.cachedThreshold;
        }

        // Recalculate threshold
        const threshold = median * config.thresholdMultiplier;
        this.cachedThreshold = threshold;

        return threshold;
    }

    /**
     * Determine device state based on RTT analysis
     * @param recentRtts Array of recent RTT measurements (typically last 3)
     * @param currentRtt Current RTT measurement
     * @param currentState Current device state
     * @returns Analysis result with state and metrics
     */
    determineState(recentRtts: number[], currentRtt: number, currentState: string): StateAnalysisResult {
        // If marked OFFLINE due to high RTT, keep that state
        if (currentState === 'OFFLINE' && currentRtt > config.offlineThreshold) {
            return {
                median: this.calculateMedian(),
                threshold: this.calculateThreshold(),
                state: 'OFFLINE',
                movingAvg: currentRtt
            };
        }

        // Calculate device's moving average
        const movingAvg = recentRtts.length > 0
            ? recentRtts.reduce((a, b) => a + b, 0) / recentRtts.length
            : currentRtt;

        // Calculate global median and threshold
        // Always ensure we have valid calculations when determining state
        const historySize = this.globalRttHistory.length;

        // Recalculate if we have enough data and cache is stale or needs refresh
        const shouldRecalculate = historySize >= config.recentRttCount && (
            historySize - this.lastCalculationSize >= this.RECALCULATION_INTERVAL ||
            this.lastCalculationSize === 0 ||
            this.cachedMedian === 0
        );

        let median = this.cachedMedian;
        let threshold = this.cachedThreshold;

        if (shouldRecalculate && historySize >= config.recentRttCount) {
            // Recalculate median and threshold
            const sorted = [...this.globalRttHistory].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            threshold = median * config.thresholdMultiplier;

            // Update cache
            this.cachedMedian = median;
            this.cachedThreshold = threshold;
            this.lastCalculationSize = historySize;
        } else if (historySize >= config.recentRttCount && (median === 0 || threshold === 0)) {
            // Fallback: if cache is empty but we have data, calculate now
            const sorted = [...this.globalRttHistory].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            threshold = median * config.thresholdMultiplier;

            // Update cache
            this.cachedMedian = median;
            this.cachedThreshold = threshold;
            this.lastCalculationSize = historySize;
        }

        let state: string;
        if (historySize >= config.recentRttCount) {
            // State determination: compare moving average to threshold
            // Moving average below threshold = Active (device responding quickly)
            // Moving average above threshold = Standby (device responding slowly)
            state = movingAvg < threshold ? 'Online' : 'Standby';
        } else {
            // Not enough data points yet - still calibrating
            state = 'Calibrating...';
        }

        // Ensure we have valid values (should not be 0 if we have enough data)
        if (historySize >= config.recentRttCount && (median === 0 || threshold === 0)) {
            console.warn(`[RTT ANALYZER] Warning: Invalid median (${median}) or threshold (${threshold}) with ${historySize} measurements`);
        }

        return {
            median,
            threshold,
            state,
            movingAvg
        };
    }

    /**
     * Get current global history size
     * @returns Number of measurements in history
     */
    getHistorySize(): number {
        return this.globalRttHistory.length;
    }

    /**
     * Get cached median value
     * @returns Cached median or 0 if not calculated
     */
    getCachedMedian(): number {
        return this.cachedMedian;
    }

    /**
     * Get cached threshold value
     * @returns Cached threshold or 0 if not calculated
     */
    getCachedThreshold(): number {
        return this.cachedThreshold;
    }

    /**
     * Clear all cached values and history
     */
    reset(): void {
        this.globalRttHistory = [];
        this.cachedMedian = 0;
        this.cachedThreshold = 0;
        this.lastCalculationSize = 0;
    }
}

