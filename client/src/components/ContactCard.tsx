import React, { useMemo, useState, useRef, useEffect } from 'react';
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Brush } from 'recharts';
import { Square, Activity, Wifi, Smartphone, Monitor, Clock, Maximize2, Shield, MessageCircle } from 'lucide-react';
import clsx from 'clsx';

// Maximum visible data points in chart for performance optimization
// Per research paper, high-frequency probing (1-2s intervals) requires efficient rendering
const MAX_VISIBLE_DATA_POINTS = 500;

/** Activity states based on RTT magnitude */
type ActivityState = 'Online' | 'Standby' | 'Offline' | 'Calibrating';

/** Network type inferred from RTT jitter */
type NetworkType = 'Wi-Fi' | 'LTE' | 'Unknown';

/** Confidence level for activity classification */
type ConfidenceLevel = 'Low' | 'Medium' | 'High';

type Platform = 'whatsapp' | 'signal';

interface TrackerData {
    rtt: number;
    windowMedian: number;
    windowJitter: number;
    magnitudeThreshold: number;
    jitterThreshold: number;
    activityState: ActivityState;
    networkType: NetworkType;
    timestamp: number;
}

interface DeviceInfo {
    jid: string;
    activityState: ActivityState;
    networkType: NetworkType;
    rtt: number;
    windowMedian: number;
    windowJitter: number;
}

interface ContactCardProps {
    jid: string;
    displayNumber: string;
    data: TrackerData[];
    devices: DeviceInfo[];
    deviceCount: number;
    presence: string | null;
    profilePic: string | null;
    onRemove: () => void;
    privacyMode?: boolean;
    confidenceLevel: ConfidenceLevel;
    observedTransitions: number;
    platform?: Platform;
}

export function ContactCard({
    jid,
    displayNumber,
    data,
    devices,
    deviceCount,
    presence,
    profilePic,
    onRemove,
    privacyMode = false,
    confidenceLevel,
    observedTransitions,
    platform = 'whatsapp'
}: ContactCardProps) {
    const lastData = data[data.length - 1];
    
    // Get current status from devices (prioritize Online, then Standby, then Offline)
    const primaryDevice = devices.length > 0 ? devices[0] : null;
    const currentActivityState: ActivityState = primaryDevice?.activityState || 'Calibrating';
    const currentNetworkType: NetworkType = primaryDevice?.networkType || 'Unknown';
    
    // Combined status string for display
    const currentStatus = currentActivityState === 'Calibrating' 
        ? 'Calibrating...'
        : `${currentActivityState} / ${currentNetworkType}`;

    // Blur phone number in privacy mode
    const blurredNumber = privacyMode ? displayNumber.replace(/\d/g, '•') : displayNumber;

    // Chart view mode: 'lastHour' or 'all'
    const [chartViewMode, setChartViewMode] = useState<'lastHour' | 'all'>('lastHour');
    // Store brush range to maintain position when new data arrives
    const brushRangeRef = useRef<{ startIndex?: number; endIndex?: number } | null>(null);
    const prevDataLengthRef = useRef<number>(0);

    /**
     * Helper function to get percentile value from sorted array
     */
    const getPercentile = (sortedValues: number[], percentile: number): number => {
        if (sortedValues.length === 0) return 0;
        const index = Math.floor(sortedValues.length * (percentile / 100));
        return sortedValues[Math.min(index, sortedValues.length - 1)];
    };

    // Filter data based on view mode with SMART outlier removal
    // Only marks ISOLATED spikes as outliers, not sustained high RTT periods
    const { chartData, outlierTimestamps } = useMemo(() => {
        if (!data || data.length === 0) {
            prevDataLengthRef.current = 0;
            return { chartData: [], outlierTimestamps: [] };
        }
        
        let filteredData = data;
        
        if (chartViewMode === 'lastHour') {
            const oneHourAgo = Date.now() - (60 * 60 * 1000);
            filteredData = data.filter(d => d.timestamp >= oneHourAgo);
        } else {
            filteredData = data.slice(-MAX_VISIBLE_DATA_POINTS);
        }
        
        // Step 1: Filter out ALL calibration data - nothing shows until windowMedian > 0
        const nonCalibrationData = filteredData.filter(d => 
            d.windowMedian > 0 && d.activityState !== 'Calibrating'
        );
        
        if (nonCalibrationData.length === 0) {
            prevDataLengthRef.current = 0;
            return { chartData: [], outlierTimestamps: [] };
        }
        
        // Step 2: CONSERVATIVE outlier detection - only truly extreme spikes
        // Must be both: (a) isolated (1-2 readings) AND (b) > 3x median value
        const onlineData = nonCalibrationData.filter(d => d.activityState !== 'Offline');
        let cleanedData = nonCalibrationData;
        let outliers: { timestamp: number; rtt: number; windowMedian: number }[] = [];
        
        if (onlineData.length >= 20) {
            // Calculate the typical RTT median
            const rttValues = onlineData.map(d => d.rtt);
            const rttSorted = [...rttValues].sort((a, b) => a - b);
            const typicalMedian = getPercentile(rttSorted, 50);
            
            // An outlier must be > 3x the typical median (truly extreme)
            // This prevents flagging normal network variations
            const extremeThreshold = Math.max(typicalMedian * 3, 5000); // At least 5000ms
            
            // First pass: mark truly extreme readings
            const isExtreme = nonCalibrationData.map(d => {
                if (d.activityState === 'Offline') return false;
                return d.rtt > extremeThreshold;
            });
            
            // Second pass: only flag if isolated (1-2 consecutive)
            // 3+ consecutive extreme readings = network degradation, not outlier
            const isIsolatedOutlier = isExtreme.map((extreme, i) => {
                if (!extreme) return false;
                
                let consecutiveCount = 1;
                for (let j = i - 1; j >= 0 && isExtreme[j]; j--) consecutiveCount++;
                for (let j = i + 1; j < isExtreme.length && isExtreme[j]; j++) consecutiveCount++;
                
                return consecutiveCount <= 2; // Only 1-2 consecutive = isolated spike
            });
            
            // Build cleaned data and outliers list
            cleanedData = [];
            for (let i = 0; i < nonCalibrationData.length; i++) {
                const d = nonCalibrationData[i];
                
                if (d.activityState === 'Offline') {
                    cleanedData.push(d);
                    continue;
                }
                
                if (isIsolatedOutlier[i]) {
                    outliers.push({ 
                        timestamp: d.timestamp, 
                        rtt: d.rtt,
                        windowMedian: d.windowMedian
                    });
                } else {
                    cleanedData.push(d);
                }
            }
        }
        
        // Adjust brush indices when new data is added
        if (chartViewMode === 'all' && brushRangeRef.current && prevDataLengthRef.current > 0) {
            const dataDiff = cleanedData.length - prevDataLengthRef.current;
            if (dataDiff > 0 && brushRangeRef.current.startIndex !== undefined && brushRangeRef.current.endIndex !== undefined) {
                brushRangeRef.current.startIndex = Math.max(0, brushRangeRef.current.startIndex + dataDiff);
                brushRangeRef.current.endIndex = Math.min(cleanedData.length - 1, brushRangeRef.current.endIndex + dataDiff);
            }
        }
        prevDataLengthRef.current = cleanedData.length;
        
        return {
            chartData: cleanedData.map(d => {
                const isOffline = d.activityState === 'Offline';
                return {
                    timestamp: d.timestamp,
                    rtt: isOffline ? null : Math.round(d.rtt),
                    rttOffline: isOffline ? Math.round(d.rtt) : null,
                    windowMedian: Math.round(d.windowMedian || 0),
                    magnitudeThreshold: Math.round(d.magnitudeThreshold || 0)
                };
            }),
            outlierTimestamps: outliers
        };
    }, [data, chartViewMode]);
    
    // Reset brush when switching view modes
    useEffect(() => {
        if (chartViewMode === 'lastHour') {
            brushRangeRef.current = null;
            prevDataLengthRef.current = 0;
        }
    }, [chartViewMode]);

    return (
        <div className="bg-gradient-to-br from-white to-gray-50 rounded-xl shadow-lg border border-gray-200 overflow-hidden">
            {/* Header with Stop Button */}
            <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <span className={clsx(
                        "px-2 py-1 rounded text-xs font-medium flex items-center gap-1",
                        platform === 'whatsapp' ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"
                    )}>
                        <MessageCircle size={12} />
                        {platform === 'whatsapp' ? 'WhatsApp' : 'Signal'}
                    </span>
                    <h3 className="text-lg font-semibold text-gray-900">{blurredNumber}</h3>
                </div>
                <button
                    onClick={onRemove}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2 font-medium transition-colors text-sm"
                >
                    <Square size={16} /> Stop
                </button>
            </div>

            <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Status Card */}
                    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 flex flex-col items-center text-center">
                        <div className="relative mb-4">
                            <div className="w-32 h-32 rounded-full overflow-hidden bg-gray-100 border-4 border-white shadow-md">
                                {profilePic ? (
                                    <img
                                        src={profilePic}
                                        alt="Profile"
                                        className={clsx(
                                            "w-full h-full object-cover transition-all duration-200",
                                            privacyMode && "blur-xl scale-110"
                                        )}
                                        style={privacyMode ? {
                                            filter: 'blur(16px) contrast(0.8)',
                                        } : {}}
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                                        No Image
                                    </div>
                                )}
                            </div>
                            <div className={clsx(
                                "absolute bottom-2 right-2 w-6 h-6 rounded-full border-2 border-white",
                                currentActivityState === 'Offline' ? "bg-red-500" :
                                    currentActivityState === 'Online' ? "bg-green-500" :
                                        currentActivityState === 'Standby' ? "bg-yellow-500" : "bg-gray-400"
                            )} />
                        </div>

                        <h4 className="text-xl font-bold text-gray-900 mb-1">{blurredNumber}</h4>

                        <div className="flex items-center gap-2 mb-4">
                            <span className={clsx(
                                "px-3 py-1 rounded-full text-sm font-medium",
                                currentActivityState === 'Offline' ? "bg-red-100 text-red-700" :
                                    currentActivityState === 'Online' ? "bg-green-100 text-green-700" :
                                        currentActivityState === 'Standby' ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-700"
                            )}>
                                {currentActivityState}
                            </span>
                            {currentNetworkType !== 'Unknown' && (
                                <span className={clsx(
                                    "px-3 py-1 rounded-full text-sm font-medium",
                                    currentNetworkType === 'Wi-Fi' ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                                )}>
                                    {currentNetworkType}
                                </span>
                            )}
                        </div>

                        <div className="w-full pt-4 border-t border-gray-100 space-y-2">
                            <div className="flex justify-between items-center text-sm text-gray-600">
                                <span className="flex items-center gap-1"><Wifi size={16} /> Official Status</span>
                                <span className="font-medium">{presence || 'Unknown'}</span>
                            </div>
                            <div className="flex justify-between items-center text-sm text-gray-600">
                                <span className="flex items-center gap-1"><Smartphone size={16} /> Devices</span>
                                <span className="font-medium">{deviceCount || 0}</span>
                            </div>
                            <div className="flex justify-between items-center text-sm text-gray-600">
                                <span className="flex items-center gap-1"><Shield size={16} /> Confidence</span>
                                <span className={clsx(
                                    "px-2 py-0.5 rounded text-xs font-medium",
                                    confidenceLevel === 'High' ? "bg-green-100 text-green-700" :
                                        confidenceLevel === 'Medium' ? "bg-yellow-100 text-yellow-700" :
                                            "bg-gray-100 text-gray-600"
                                )}>
                                    {confidenceLevel} ({observedTransitions} transitions)
                                </span>
                            </div>
                        </div>

                        {/* Device List */}
                        {devices.length > 0 && (
                            <div className="w-full pt-4 border-t border-gray-100 mt-4">
                                <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">Device States</h5>
                                <div className="space-y-2">
                                    {devices.map((device, idx) => (
                                        <div key={device.jid} className="flex items-center justify-between text-sm py-1">
                                            <div className="flex items-center gap-2">
                                                <Monitor size={14} className="text-gray-400" />
                                                <span className="text-gray-600">Device {idx + 1}</span>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className={clsx(
                                                    "px-2 py-0.5 rounded text-xs font-medium",
                                                    device.activityState === 'Offline' ? "bg-red-100 text-red-700" :
                                                        device.activityState === 'Online' ? "bg-green-100 text-green-700" :
                                                            device.activityState === 'Standby' ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-700"
                                                )}>
                                                    {device.activityState}
                                                </span>
                                                {device.networkType !== 'Unknown' && (
                                                    <span className={clsx(
                                                        "px-2 py-0.5 rounded text-xs font-medium",
                                                        device.networkType === 'Wi-Fi' ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                                                    )}>
                                                        {device.networkType}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Metrics & Chart */}
                    <div className="md:col-span-2 space-y-6">
                        {/* Metrics Grid - Two-dimensional model */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                                <div className="text-sm text-gray-500 mb-1 flex items-center gap-1"><Activity size={16} /> Window μ</div>
                                <div className="text-2xl font-bold text-gray-900">{lastData?.windowMedian?.toFixed(0) || '-'} ms</div>
                                <div className="text-xs text-gray-400">Median RTT</div>
                            </div>
                            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                                <div className="text-sm text-gray-500 mb-1">Window σ</div>
                                <div className="text-2xl font-bold text-gray-900">{lastData?.windowJitter?.toFixed(0) || '-'} ms</div>
                                <div className="text-xs text-gray-400">Jitter (IQR)</div>
                            </div>
                            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                                <div className="text-sm text-gray-500 mb-1">μ Threshold</div>
                                <div className="text-2xl font-bold text-blue-600">{lastData?.magnitudeThreshold?.toFixed(0) || '-'} ms</div>
                                <div className="text-xs text-gray-400">P75 Magnitude</div>
                            </div>
                            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                                <div className="text-sm text-gray-500 mb-1">σ Threshold</div>
                                <div className="text-2xl font-bold text-purple-600">{lastData?.jitterThreshold?.toFixed(0) || '-'} ms</div>
                                <div className="text-xs text-gray-400">P75 Jitter</div>
                            </div>
                        </div>

                        {/* Chart */}
                        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-3">
                                    <h5 className="text-sm font-medium text-gray-500">RTT History & Adaptive Threshold</h5>
                                    {outlierTimestamps.length > 0 && (
                                        <div className="relative group">
                                            <span className="flex items-center gap-1 text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded cursor-help">
                                                <span className="w-2 h-2 bg-orange-500 rounded-full"></span>
                                                {outlierTimestamps.length} outlier{outlierTimestamps.length > 1 ? 's' : ''} filtered
                                            </span>
                                            {/* Hover popup showing outlier details */}
                                            <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block bg-white border border-orange-200 rounded-lg shadow-lg p-3 min-w-[200px] max-h-[200px] overflow-y-auto">
                                                <div className="text-xs font-semibold text-orange-600 mb-2">⚠ Filtered Spikes</div>
                                                {outlierTimestamps.slice(0, 10).map((o, i) => (
                                                    <div key={i} className="text-xs text-gray-600 py-1 border-b border-gray-100 last:border-0">
                                                        <span className="font-medium">{new Date(o.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                                        <span className="ml-2">RTT: {Math.round(o.rtt)}ms</span>
                                                    </div>
                                                ))}
                                                {outlierTimestamps.length > 10 && (
                                                    <div className="text-xs text-gray-400 pt-1">...and {outlierTimestamps.length - 10} more</div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={() => setChartViewMode(chartViewMode === 'lastHour' ? 'all' : 'lastHour')}
                                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                                    title={chartViewMode === 'lastHour' ? 'Show all data' : 'Show last hour'}
                                >
                                    {chartViewMode === 'lastHour' ? (
                                        <>
                                            <Maximize2 size={14} />
                                            <span>View All</span>
                                        </>
                                    ) : (
                                        <>
                                            <Clock size={14} />
                                            <span>Last Hour</span>
                                        </>
                                    )}
                                </button>
                            </div>
                            <div style={{ width: '100%', height: '250px', minHeight: '200px' }}>
                                {chartData.length > 0 ? (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ComposedChart 
                                            data={chartData}
                                            margin={{ 
                                                top: 5, 
                                                right: 10, 
                                                left: 0, 
                                                bottom: chartViewMode === 'all' ? 80 : 20 
                                            }}
                                        >
                                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                                            <XAxis 
                                                dataKey="timestamp" 
                                                scale="time"
                                                type="number"
                                                domain={['dataMin', 'dataMax']}
                                                tickFormatter={(value) => {
                                                    if (!value) return '';
                                                    const date = new Date(value);
                                                    return chartViewMode === 'all' 
                                                        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                                        : '';
                                                }}
                                                angle={chartViewMode === 'all' ? -45 : 0}
                                                textAnchor={chartViewMode === 'all' ? 'end' : 'middle'}
                                                height={chartViewMode === 'all' ? 60 : 0}
                                                style={{ fontSize: '11px' }}
                                                hide={chartViewMode === 'lastHour'}
                                            />
                                            <YAxis domain={['auto', 'auto']} />
                                            <Tooltip
                                                labelFormatter={(t: number) => {
                                                    if (!t) return '';
                                                    const date = new Date(t);
                                                    const dateStr = date.toLocaleDateString([], { 
                                                        month: 'short', 
                                                        day: 'numeric', 
                                                        year: 'numeric'
                                                    });
                                                    const timeStr = date.toLocaleTimeString([], { 
                                                        hour: '2-digit', 
                                                        minute: '2-digit',
                                                        second: '2-digit',
                                                        hour12: false
                                                    });
                                                    return `Time: ${dateStr} ${timeStr}`;
                                                }}
                                                formatter={(value: any, name: string, props: any) => {
                                                    if (value === null || value === undefined) return null;
                                                    const numValue = typeof value === 'number' ? value : parseFloat(value);
                                                    if (isNaN(numValue)) return null;
                                                    const roundedValue = Math.round(numValue);
                                                    
                                                    // Handle outlier dots specially
                                                    if (name === 'Outlier' && props?.payload?.isOutlier) {
                                                        const outlierRtt = props.payload.outlierRtt;
                                                        const outlierMedian = props.payload.outlierMedian;
                                                        return [`RTT: ${outlierRtt}ms, Window μ: ${outlierMedian}ms`, '⚠ Filtered Spike'];
                                                    }
                                                    
                                                    if (name === 'RTT' || name === 'rtt') {
                                                        return [`${roundedValue} ms`, 'RTT'];
                                                    }
                                                    if (name === 'RTT (Offline)' || name === 'rttOffline') {
                                                        return [`${roundedValue} ms`, 'RTT (Offline)'];
                                                    }
                                                    if (name === 'Window Median' || name === 'windowMedian') {
                                                        return [`${roundedValue} ms`, 'Window μ'];
                                                    }
                                                    if (name === 'μ Threshold' || name === 'magnitudeThreshold') {
                                                        return [`${roundedValue} ms`, 'μ Threshold (P75)'];
                                                    }
                                                    return [`${roundedValue} ms`, name];
                                                }}
                                                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', padding: '12px' }}
                                                labelStyle={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '13px', color: '#374151' }}
                                            />
                                            {chartViewMode === 'all' && chartData.length > 10 && (
                                                <Brush 
                                                    dataKey="timestamp"
                                                    height={30}
                                                    stroke="#8884d8"
                                                    tickFormatter={(value) => {
                                                        const date = new Date(value);
                                                        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                                    }}
                                                    startIndex={brushRangeRef.current?.startIndex}
                                                    endIndex={brushRangeRef.current?.endIndex !== undefined ? brushRangeRef.current.endIndex : chartData.length - 1}
                                                    onChange={(brushData: any) => {
                                                        if (brushData && typeof brushData.startIndex === 'number' && typeof brushData.endIndex === 'number') {
                                                            brushRangeRef.current = {
                                                                startIndex: brushData.startIndex,
                                                                endIndex: brushData.endIndex
                                                            };
                                                        }
                                                    }}
                                                />
                                            )}
                                            <Line type="monotone" dataKey="rtt" stroke="#3b82f6" strokeWidth={2} dot={false} name="RTT" isAnimationActive={false} connectNulls={false} />
                                            <Line type="monotone" dataKey="rttOffline" stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 5" dot={false} name="RTT (Offline)" isAnimationActive={false} connectNulls={false} />
                                            <Line type="monotone" dataKey="windowMedian" stroke="#10b981" strokeWidth={1.5} dot={false} name="Window Median" isAnimationActive={false} />
                                            <Line type="step" dataKey="magnitudeThreshold" stroke="#ef4444" strokeDasharray="5 5" dot={false} name="μ Threshold" isAnimationActive={false} />
                                        </ComposedChart>
                                    </ResponsiveContainer>
                                ) : (
                                    <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                                        No data available
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
