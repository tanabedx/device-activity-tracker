import React, { useEffect, useState } from 'react';
import {Eye, EyeOff, Plus} from 'lucide-react';
import { socket } from '../App';
import { ContactCard } from './ContactCard';

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
}

export function Dashboard() {
    const [inputNumber, setInputNumber] = useState('');
    const [contacts, setContacts] = useState<Map<string, ContactInfo>>(new Map());
    const [error, setError] = useState<string | null>(null);
    const [privacyMode, setPrivacyMode] = useState(false);

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

        function onContactAdded(data: { jid: string, number: string }) {
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
                    observedTransitions: 0
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

        // Handle restore of tracked contacts on reconnect/page reload
        function onTrackedContacts(jids: string[]) {
            console.log('[Dashboard] tracked-contacts event received:', jids);
            if (!jids || jids.length === 0) {
                console.log('[Dashboard] No contacts to restore');
                return;
            }
            
            setContacts(prev => {
                const next = new Map(prev);
                for (const jid of jids) {
                    if (!next.has(jid)) {
                        // Extract phone number from JID
                        const number = jid.replace('@s.whatsapp.net', '');
                        console.log('[Dashboard] Restoring contact:', jid, number);
                        next.set(jid, {
                            jid,
                            displayNumber: number,
                            contactName: number,
                            data: [],
                            devices: [],
                            deviceCount: 0,
                            presence: null,
                            profilePic: null,
                            confidenceLevel: 'Low',
                            observedTransitions: 0
                        });
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
            socket.off('tracked-contacts', onTrackedContacts);
            socket.off('historical-data', onHistoricalData);
        };
    }, []);

    const handleAdd = () => {
        if (!inputNumber) return;
        socket.emit('add-contact', inputNumber);
    };

    const handleRemove = (jid: string) => {
        socket.emit('remove-contact', jid);
    };

    return (
        <div className="space-y-6">
            {/* Add Contact Form */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-semibold text-gray-900">Track Contacts</h2>
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
                <div className="flex gap-4">
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
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
