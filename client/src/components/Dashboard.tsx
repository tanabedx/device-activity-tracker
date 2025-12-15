import React, { useEffect, useState } from 'react';
import {Eye, EyeOff, Plus, Trash2, Zap, MessageCircle, Settings} from 'lucide-react';
import { socket, Platform, ConnectionState } from '../App';
import { ContactCard } from './ContactCard';
import { Login } from './Login';

type ProbeMethod = 'delete' | 'reaction';

interface DashboardProps {
    connectionState: ConnectionState;
}

/** Activity states based on RTT magnitude */
type ActivityState = 'Online' | 'Standby' | 'Offline' | 'Calibrating';

/** Network type inferred from RTT jitter */
type NetworkType = 'Wi-Fi' | 'LTE' | 'Unknown';

/** Confidence level for activity classification */
type ConfidenceLevel = 'Low' | 'Medium' | 'High';

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

interface ContactInfo {
    jid: string;
    displayNumber: string;
    contactName: string;
    data: TrackerData[];
    devices: DeviceInfo[];
    deviceCount: number;
    presence: string | null;
    profilePic: string | null;
    confidenceLevel: ConfidenceLevel;
    observedTransitions: number;
    platform: Platform;
}

export function Dashboard({ connectionState }: DashboardProps) {
    const [inputNumber, setInputNumber] = useState('');
    const [selectedPlatform, setSelectedPlatform] = useState<Platform>(
        connectionState.whatsapp ? 'whatsapp' : 'signal'
    );
    const [contacts, setContacts] = useState<Map<string, ContactInfo>>(new Map());
    const [error, setError] = useState<string | null>(null);
    const [privacyMode, setPrivacyMode] = useState(false);
    const [probeMethod, setProbeMethod] = useState<ProbeMethod>('delete');
    const [showConnections, setShowConnections] = useState(false);

    useEffect(() => {
        function onTrackerUpdate(update: any) {
            const { jid, ...data } = update;
            if (!jid) return;

            setContacts(prev => {
                const next = new Map(prev);
                const contact = next.get(jid);

                if (contact) {
                    // Update existing contact
                    const updatedContact = { ...contact };

                    if (data.presence !== undefined) {
                        updatedContact.presence = data.presence;
                    }
                    if (data.deviceCount !== undefined) {
                        updatedContact.deviceCount = data.deviceCount;
                    }
                    if (data.devices !== undefined) {
                        updatedContact.devices = data.devices;
                    }
                    if (data.confidenceLevel !== undefined) {
                        updatedContact.confidenceLevel = data.confidenceLevel;
                    }
                    if (data.observedTransitions !== undefined) {
                        updatedContact.observedTransitions = data.observedTransitions;
                    }

                    // Add to chart data (new two-dimensional model)
                    if (data.devices && data.devices.length > 0) {
                        const primaryDevice = data.devices[0];
                        const newDataPoint: TrackerData = {
                            rtt: primaryDevice.rtt,
                            windowMedian: primaryDevice.windowMedian || 0,
                            windowJitter: primaryDevice.windowJitter || 0,
                            magnitudeThreshold: data.magnitudeThreshold || 0,
                            jitterThreshold: data.jitterThreshold || 0,
                            activityState: primaryDevice.activityState || 'Calibrating',
                            networkType: primaryDevice.networkType || 'Unknown',
                            timestamp: Date.now(),
                        };
                        updatedContact.data = [...updatedContact.data, newDataPoint];
                    }

                    next.set(jid, updatedContact);
                }

                return next;
            });
        }

        function onProfilePic(data: { jid: string, url: string | null }) {
            setContacts(prev => {
                const next = new Map(prev);
                const contact = next.get(data.jid);
                if (contact) {
                    next.set(data.jid, { ...contact, profilePic: data.url });
                }
                return next;
            });
        }

        function onContactName(data: { jid: string, name: string }) {
            setContacts(prev => {
                const next = new Map(prev);
                const contact = next.get(data.jid);
                if (contact) {
                    next.set(data.jid, { ...contact, contactName: data.name });
                }
                return next;
            });
        }

        function onContactAdded(data: { jid: string, number: string, platform?: Platform }) {
            setContacts(prev => {
                const next = new Map(prev);
                next.set(data.jid, {
                    jid: data.jid,
                    displayNumber: data.number,
                    contactName: data.number,
                    data: [],
                    devices: [],
                    deviceCount: 0,
                    presence: null,
                    profilePic: null,
                    confidenceLevel: 'Low',
                    observedTransitions: 0,
                    platform: data.platform || 'whatsapp'
                });
                return next;
            });
            setInputNumber('');
        }

        function onContactRemoved(jid: string) {
            setContacts(prev => {
                const next = new Map(prev);
                next.delete(jid);
                return next;
            });
        }

        function onError(data: { jid?: string, message: string }) {
            setError(data.message);
            setTimeout(() => setError(null), 3000);
        }

        function onProbeMethod(method: ProbeMethod) {
            setProbeMethod(method);
        }

        // Handle restore of tracked contacts on reconnect/page reload
        function onTrackedContacts(contacts: { id: string, platform: Platform }[] | string[]) {
            console.log('[Dashboard] tracked-contacts event received:', contacts);
            if (!contacts || contacts.length === 0) {
                console.log('[Dashboard] No contacts to restore');
                return;
            }
            
            setContacts(prev => {
                const next = new Map(prev);
                
                // Handle both formats: array of objects with platform, or array of JIDs
                const isObjectFormat = contacts.length > 0 && typeof contacts[0] === 'object' && 'id' in contacts[0];
                
                if (isObjectFormat) {
                    // HEAD format: { id: string, platform: Platform }[]
                    (contacts as { id: string, platform: Platform }[]).forEach(({ id, platform }) => {
                        if (!next.has(id)) {
                            // Extract display number from id
                            let displayNumber = id;
                            if (platform === 'signal') {
                                displayNumber = id.replace('signal:', '');
                            } else {
                                // WhatsApp JID format: number@s.whatsapp.net
                                displayNumber = id.split('@')[0];
                            }
                            console.log('[Dashboard] Restoring contact:', id, displayNumber, platform);
                            next.set(id, {
                                jid: id,
                                displayNumber,
                                contactName: displayNumber,
                                data: [],
                                devices: [],
                                deviceCount: 0,
                                presence: null,
                                profilePic: null,
                                confidenceLevel: 'Low',
                                observedTransitions: 0,
                                platform
                            });
                        }
                    });
                } else {
                    // frontend-improvements format: string[]
                    for (const jid of contacts as string[]) {
                        if (!next.has(jid)) {
                            // Extract phone number from JID
                            let displayNumber = jid;
                            let platform: Platform = 'whatsapp';
                            if (jid.startsWith('signal:')) {
                                displayNumber = jid.replace('signal:', '');
                                platform = 'signal';
                            } else {
                                displayNumber = jid.replace('@s.whatsapp.net', '');
                            }
                            console.log('[Dashboard] Restoring contact:', jid, displayNumber);
                            next.set(jid, {
                                jid,
                                displayNumber,
                                contactName: displayNumber,
                                data: [],
                                devices: [],
                                deviceCount: 0,
                                presence: null,
                                profilePic: null,
                                confidenceLevel: 'Low',
                                observedTransitions: 0,
                                platform
                            });
                        }
                    }
                }
                return next;
            });
        }

        // Log socket connection status
        console.log('[Dashboard] Setting up socket listeners, socket connected:', socket.connected);
        
        socket.on('connect', () => {
            console.log('[Dashboard] Socket connected, requesting tracked contacts');
            socket.emit('get-tracked-contacts');
        });

        // Handle historical data for reconnecting clients
        function onHistoricalData(payload: { jid: string, data: TrackerData[] }) {
            console.log('[Dashboard] Received historical data for', payload.jid, ':', payload.data.length, 'points');
            setContacts(prev => {
                const next = new Map(prev);
                const contact = next.get(payload.jid);
                if (contact) {
                    // Merge historical data (avoid duplicates by timestamp)
                    const existingTimestamps = new Set(contact.data.map(d => d.timestamp));
                    const newData = payload.data.filter(d => !existingTimestamps.has(d.timestamp));
                    const mergedData = [...newData, ...contact.data].sort((a, b) => a.timestamp - b.timestamp);
                    next.set(payload.jid, { ...contact, data: mergedData });
                }
                return next;
            });
        }

        socket.on('tracker-update', onTrackerUpdate);
        socket.on('profile-pic', onProfilePic);
        socket.on('contact-name', onContactName);
        socket.on('contact-added', onContactAdded);
        socket.on('contact-removed', onContactRemoved);
        socket.on('error', onError);
        socket.on('probe-method', onProbeMethod);
        socket.on('tracked-contacts', onTrackedContacts);
        socket.on('historical-data', onHistoricalData);
        
        // If already connected, request tracked contacts immediately
        if (socket.connected) {
            console.log('[Dashboard] Already connected, requesting tracked contacts');
            socket.emit('get-tracked-contacts');
        }

        return () => {
            socket.off('connect');
            socket.off('tracker-update', onTrackerUpdate);
            socket.off('profile-pic', onProfilePic);
            socket.off('contact-name', onContactName);
            socket.off('contact-added', onContactAdded);
            socket.off('contact-removed', onContactRemoved);
            socket.off('error', onError);
            socket.off('probe-method', onProbeMethod);
            socket.off('tracked-contacts', onTrackedContacts);
            socket.off('historical-data', onHistoricalData);
        };
    }, []);

    const handleAdd = () => {
        if (!inputNumber) return;
        socket.emit('add-contact', { number: inputNumber, platform: selectedPlatform });
    };

    const handleRemove = (jid: string) => {
        socket.emit('remove-contact', jid);
    };

    const handleProbeMethodChange = (method: ProbeMethod) => {
        socket.emit('set-probe-method', method);
    };

    return (
        <div className="space-y-6">
            {/* Add Contact Form */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                <div className="flex justify-between items-center mb-4">
                    <div className="flex items-center gap-4">
                        <h2 className="text-xl font-semibold text-gray-900">Track Contacts</h2>
                        {/* Manage Connections button */}
                        <button
                            onClick={() => setShowConnections(!showConnections)}
                            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-1 ${
                                showConnections
                                    ? 'bg-gray-700 text-white'
                                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                            }`}
                        >
                            <Settings size={14} />
                            {showConnections ? 'Hide Connections' : 'Manage Connections'}
                        </button>
                    </div>
                    <div className="flex items-center gap-4">
                        {/* Probe Method Toggle */}
                        <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-600">Probe Method:</span>
                            <div className="flex rounded-lg overflow-hidden border border-gray-300">
                                <button
                                    onClick={() => handleProbeMethodChange('delete')}
                                    className={`px-3 py-1.5 text-sm font-medium transition-all duration-200 flex items-center gap-1 ${
                                        probeMethod === 'delete'
                                            ? 'bg-purple-600 text-white'
                                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                    }`}
                                    title="Silent Delete Probe - Completely covert, target sees nothing"
                                >
                                    <Trash2 size={14} />
                                    Delete
                                </button>
                                <button
                                    onClick={() => handleProbeMethodChange('reaction')}
                                    className={`px-3 py-1.5 text-sm font-medium transition-all duration-200 flex items-center gap-1 ${
                                        probeMethod === 'reaction'
                                            ? 'bg-yellow-500 text-white'
                                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                    }`}
                                    title="Reaction Probe - Sends reactions to non-existent messages"
                                >
                                    <Zap size={14} />
                                    Reaction
                                </button>
                            </div>
                        </div>
                        {/* Privacy Mode Toggle */}
                        <button
                            onClick={() => setPrivacyMode(!privacyMode)}
                            className={`px-4 py-2 rounded-lg flex items-center gap-2 font-medium transition-all duration-200 ${
                                privacyMode 
                                    ? 'bg-green-600 text-white hover:bg-green-700 shadow-md' 
                                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                            }`}
                            title={privacyMode ? 'Privacy Mode: ON (Click to disable)' : 'Privacy Mode: OFF (Click to enable)'}
                        >
                            {privacyMode ? (
                                <>
                                    <EyeOff size={20} />
                                    <span>Privacy ON</span>
                                </>
                            ) : (
                                <>
                                    <Eye size={20} />
                                    <span>Privacy OFF</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>
                <div className="flex gap-4">
                    {/* Platform Selector */}
                    <div className="flex rounded-lg overflow-hidden border border-gray-300">
                        <button
                            onClick={() => setSelectedPlatform('whatsapp')}
                            disabled={!connectionState.whatsapp}
                            className={`px-4 py-2 text-sm font-medium transition-all duration-200 flex items-center gap-2 ${
                                selectedPlatform === 'whatsapp'
                                    ? 'bg-green-600 text-white'
                                    : connectionState.whatsapp
                                        ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            }`}
                            title={connectionState.whatsapp ? 'WhatsApp' : 'WhatsApp not connected'}
                        >
                            <MessageCircle size={16} />
                            WhatsApp
                        </button>
                        <button
                            onClick={() => setSelectedPlatform('signal')}
                            disabled={!connectionState.signal}
                            className={`px-4 py-2 text-sm font-medium transition-all duration-200 flex items-center gap-2 ${
                                selectedPlatform === 'signal'
                                    ? 'bg-blue-600 text-white'
                                    : connectionState.signal
                                        ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            }`}
                            title={connectionState.signal ? 'Signal' : 'Signal not connected'}
                        >
                            <MessageCircle size={16} />
                            Signal
                        </button>
                    </div>
                    <input
                        type="text"
                        placeholder="Enter phone number (e.g. 491701234567)"
                        className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        value={inputNumber}
                        onChange={(e) => setInputNumber(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleAdd()}
                    />
                    <button
                        onClick={handleAdd}
                        className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2 font-medium transition-colors"
                    >
                        <Plus size={20} /> Add Contact
                    </button>
                </div>
                {error && <p className="mt-2 text-red-500 text-sm">{error}</p>}
            </div>

            {/* Connections Panel */}
            {showConnections && (
                <Login connectionState={connectionState} />
            )}

            {/* Contact Cards */}
            {contacts.size === 0 ? (
                <div className="bg-gray-50 border-2 border-dashed border-gray-300 rounded-xl p-12 text-center">
                    <p className="text-gray-500 text-lg">No contacts being tracked</p>
                    <p className="text-gray-400 text-sm mt-2">Add a contact above to start tracking</p>
                </div>
            ) : (
                <div className="space-y-6">
                    {Array.from(contacts.values()).map(contact => (
                        <ContactCard
                            key={contact.jid}
                            jid={contact.jid}
                            displayNumber={contact.contactName}
                            data={contact.data}
                            devices={contact.devices}
                            deviceCount={contact.deviceCount}
                            presence={contact.presence}
                            profilePic={contact.profilePic}
                            onRemove={() => handleRemove(contact.jid)}
                            privacyMode={privacyMode}
                            confidenceLevel={contact.confidenceLevel}
                            observedTransitions={contact.observedTransitions}
                            platform={contact.platform}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
