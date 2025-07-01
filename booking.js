// Booking page functionality for NostrCal
// Global state
let currentDate = new Date();
let selectedDate = null;
let selectedTime = null;
let availabilityData = null;
let ownerPubkey = null;
let busyTimes = new Map();
let relayConnections = new Map();

// Enhanced state management for RSVP conflict resolution
let processedEventIds = new Set(); // Track processed events to prevent duplicates
let rsvpHistory = new Map(); // Track all RSVPs per booking: eventId -> [rsvpEvents...]

// Store accepted RSVPs and referenced bookings separately
let acceptedRSVPs = new Map(); // eventId -> rsvpEvent
let pendingBookingFetches = new Set(); // Track which booking events we're fetching

// Default relays - you can modify these
const DEFAULT_RELAYS = [
    'wss://filter.nostrcal.com',
    'wss://relay.nostrcal.com',
    'wss://purplepag.es/'
];

// Initialize nostr-login for booking page
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, setting up nostr-login for booking page...');
    
    // Listen for auth events
    document.addEventListener('nlAuth', async (e) => {
        console.log('Auth event received on booking page:', e.detail);
        // Handle auth if needed for booking flow
    });
    
    // Handle Enter key in naddr input
    const naddrInput = document.getElementById('naddrInput');
    if (naddrInput) {
        naddrInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                loadAvailability();
            }
        });
    }
    
    // Initialize timezone display
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezoneDisplay = document.getElementById('timezoneDisplay');
    if (timezoneDisplay) {
        timezoneDisplay.textContent = timezone;
    }
    
    // Check for naddr in URL parameters or hash
    const urlParams = new URLSearchParams(window.location.search);
    const hashNaddr = window.location.hash.slice(1); // Remove #
    const paramNaddr = urlParams.get('naddr');
    
    // Try to get naddr from URL parameter first, then hash
    let autoNaddr = paramNaddr || hashNaddr;
    
    // Handle path-based URLs like /booking/naddr
    if (!autoNaddr && window.location.pathname.includes('/booking/')) {
        const pathParts = window.location.pathname.split('/booking/');
        if (pathParts.length > 1 && pathParts[1]) {
            autoNaddr = decodeURIComponent(pathParts[1]);
        }
    }
    
    if (autoNaddr) {
        console.log('🔗 Auto-loading naddr from URL:', autoNaddr);
        
        // Ensure it starts with nostr: if it doesn't
        if (!autoNaddr.startsWith('nostr:')) {
            autoNaddr = 'nostr:' + autoNaddr;
        }
        
        // Populate the input field
        if (naddrInput) {
            naddrInput.value = autoNaddr;
        }
        
        // Auto-load the availability after a short delay
        setTimeout(() => {
            console.log('🚀 Auto-triggering availability load...');
            loadAvailability();
        }, 500);
    }
    
    console.log('Booking page setup complete');
});

// Enhanced function to clear state when going back or loading new availability
function clearBookingState() {
    selectedDate = null;
    selectedTime = null;
    availabilityData = null;
    busyTimes.clear();
    acceptedRSVPs.clear();
    pendingBookingFetches.clear();
    processedEventIds.clear(); // Clear processed events tracking
    rsvpHistory.clear(); // Clear RSVP history
    relayConnections.forEach(ws => ws.close());
    relayConnections.clear();
}

async function loadAvailability() {
    const naddrInput = document.getElementById('naddrInput');
    const naddr = naddrInput.value.trim();
    
    if (!naddr || !naddr.startsWith('nostr:naddr')) {
        showError('Please enter a valid naddr booking link starting with "nostr:naddr"');
        return;
    }
    
    console.log('Loading availability for naddr:', naddr);
    
    showLoading(true);
    hideMessages();
    
    // Clear previous data using enhanced clearing
    clearBookingState();
    ownerPubkey = null;
    availabilityData = null;
    
    try {
        // Connect to relays
        console.log('Connecting to relays...');
        await connectToRelays();
        console.log('Connected to', relayConnections.size, 'relays');
        
        // Parse naddr and fetch availability template
        console.log('Parsing naddr...');
        const parsed = parseNaddr(naddr);
        console.log('Parsed naddr result:', parsed);
        
        console.log('Fetching availability template...');
        await fetchAvailabilityTemplate(parsed);
        console.log('Availability template fetched successfully');
        
        // Fetch busy times from owner's calendar
        if (ownerPubkey && availabilityData) {
            console.log('Fetching busy times for owner:', ownerPubkey);
            console.log('Using calendar reference:', availabilityData.calendarRef);
            
            setTimeout(async () => {
                console.log('🔍 Starting busy times fetch...');
                await fetchBusyTimes();
                console.log('Busy times fetch initiated');
                
                // Wait for RSVP processing to complete and debug conflicts
                setTimeout(() => {
                    console.log('📊 Final state summary:');
                    console.log('  Busy times count:', busyTimes.size);
                    console.log('  Accepted RSVPs count:', acceptedRSVPs.size);
                    console.log('  RSVP history entries:', rsvpHistory.size);
                    console.log('  Processed events count:', processedEventIds.size);
                    
                    // Debug any conflicts found
                    debugRSVPConflicts();
                }, 5000);
                
            }, 2000);
        } else {
            console.log('No owner pubkey or availability data found, skipping busy times fetch');
        }
        
        // Show booking interface
        console.log('Showing booking interface...');
        showBookingInterface();
        
    } catch (error) {
        console.error('Error loading availability:', error);
        showError('Failed to load availability: ' + error.message + ' (Check browser console for details)');
    } finally {
        showLoading(false);
    }
}

function parseNaddr(naddr) {
    try {
        const parts = naddr.split(':');
        if (parts.length < 2) throw new Error('Invalid naddr format');
        
        const identifier = extractIdentifierFromNaddr(naddr);
        console.log('Extracted identifier from naddr:', identifier);
        
        return {
            kind: 31926, // Availability template
            identifier: identifier
        };
    } catch (error) {
        throw new Error('Could not parse naddr: ' + error.message);
    }
}

function extractIdentifierFromNaddr(naddr) {
    try {
        const match = naddr.match(/31926(.+)$/);
        if (match) {
            console.log('Found template ID in naddr:', match[1]);
            return match[1];
        }
        
        // Fallback for old 30001 format during transition
        const oldMatch = naddr.match(/30001(.+)$/);
        if (oldMatch) {
            console.log('Found old 30001 template ID in naddr:', oldMatch[1]);
            return oldMatch[1];
        }
        
        const fallbackMatch = naddr.match(/avail-[\w-]+/);
        if (fallbackMatch) {
            console.log('Using fallback pattern match:', fallbackMatch[0]);
            return fallbackMatch[0];
        }
        
        console.log('No pattern matched, using default');
        return 'avail-weekly';
    } catch (error) {
        console.error('Error extracting identifier:', error);
        return 'avail-weekly';
    }
}

async function connectToRelays() {
    console.log('Attempting to connect to relays:', DEFAULT_RELAYS);
    const promises = DEFAULT_RELAYS.map(url => connectToRelay(url));
    const results = await Promise.allSettled(promises);
    
    console.log('Relay connection results:', results);
    
    if (relayConnections.size === 0) {
        throw new Error('Could not connect to any relays. Please check your internet connection.');
    }
    
    console.log(`Successfully connected to ${relayConnections.size} out of ${DEFAULT_RELAYS.length} relays`);
}

function connectToRelay(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        
        ws.onopen = () => {
            console.log(`Connected to ${url}`);
            relayConnections.set(url, ws);
            resolve(ws);
        };
        
        ws.onerror = (error) => {
            console.error(`Failed to connect to ${url}:`, error);
            reject(error);
        };
        
        ws.onmessage = (event) => {
            handleRelayMessage(url, JSON.parse(event.data));
        };

        setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                ws.close();
                reject(new Error('Connection timeout'));
            }
        }, 5000);
    });
}

function handleRelayMessage(relayUrl, message) {
    const [type, subscriptionId, event] = message;
    
    if (type === 'EVENT') {
        console.log(`Received event from ${relayUrl}:`, {
            kind: event.kind,
            pubkey: event.pubkey?.slice(0, 8) + '...',
            id: event.id?.slice(0, 8) + '...',
            isOwnerEvent: event.pubkey === ownerPubkey,
            subscription: subscriptionId
        });
        
        if (event.kind === 31926) {
            console.log('→ Processing availability template');
            processAvailabilityTemplate(event);
        } else if ([31922, 31923].includes(event.kind)) {
            console.log(`→ Processing ${event.kind === 31922 ? 'date-based' : 'time-based'} calendar event`);
            processBusyEvent(event);
        } else if (event.kind === 31925) {
            console.log('→ Processing RSVP event');
            processRSVPEvent(event);
        } else {
            console.log(`→ Ignoring event of kind ${event.kind}`);
        }
    } else if (type === 'EOSE') {
        console.log(`End of stored events from ${relayUrl} for subscription ${subscriptionId}`);
        
        // If this is the end of RSVP fetching, start fetching referenced bookings
        if (subscriptionId.includes('busy-') && acceptedRSVPs.size > 0) {
            setTimeout(() => {
                fetchReferencedBookings();
            }, 1000);
        }
    } else {
        console.log(`Other message type from ${relayUrl}:`, type, message);
    }
}

async function fetchAvailabilityTemplate(parsed) {
    return new Promise((resolve, reject) => {
        let filter = {
            kinds: [31926],
            '#d': [parsed.identifier],
            limit: 10
        };
        
        console.log('Searching for availability template with filter:', filter);
        
        const subscriptionId = 'availability-' + Date.now();
        const request = ['REQ', subscriptionId, filter];
        
        let resolved = false;
        let foundTemplate = false;
        
        relayConnections.forEach((ws, url) => {
            if (ws.readyState === WebSocket.OPEN) {
                console.log(`Sending query to ${url}`);
                ws.send(JSON.stringify(request));
            }
        });
        
        setTimeout(() => {
            if (!foundTemplate && !resolved) {
                console.log('No specific match found, trying broader search...');
                
                const broadFilter = {
                    kinds: [31926],
                    limit: 50
                };
                
                const broadSubId = 'broad-availability-' + Date.now();
                const broadRequest = ['REQ', broadSubId, broadFilter];
                
                relayConnections.forEach((ws, url) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        console.log(`Sending broad query to ${url}`);
                        ws.send(JSON.stringify(broadRequest));
                    }
                });
            }
        }, 5000);
        
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                if (!foundTemplate) {
                    console.log('Timeout reached, no templates found');
                    reject(new Error('No availability template found for this link'));
                }
            }
        }, 15000);
        
        window.resolveAvailability = () => {
            if (!resolved) {
                resolved = true;
                foundTemplate = true;
                resolve();
            }
        };
        
        window.foundTemplateFlag = () => {
            foundTemplate = true;
        };
    });
}

function processAvailabilityTemplate(event) {
    console.log('Processing availability template:', event);
    
    ownerPubkey = event.pubkey;
    
    const dTag = event.tags.find(tag => tag[0] === 'd')?.[1];
    const calendarRef = event.tags.find(tag => tag[0] === 'a')?.[1];
    const timezone = event.tags.find(tag => tag[0] === 'tzid')?.[1] || 'UTC';
    const duration = event.tags.find(tag => tag[0] === 'duration')?.[1] || 'PT30M';
    const interval = event.tags.find(tag => tag[0] === 'interval')?.[1] || duration;
    const amountSats = event.tags.find(tag => tag[0] === 'amount_sats')?.[1];
    const bufferBefore = event.tags.find(tag => tag[0] === 'buffer_before')?.[1] || 'PT0S';
    const bufferAfter = event.tags.find(tag => tag[0] === 'buffer_after')?.[1] || 'PT0S';
    const minNotice = event.tags.find(tag => tag[0] === 'min_notice')?.[1] || 'PT0S';
    const maxAdvance = event.tags.find(tag => tag[0] === 'max_advance')?.[1] || 'P30D';
    const location = event.tags.find(tag => tag[0] === 'location')?.[1] || 'Online Meeting';
    const title = event.tags.find(tag => tag[0] === 'title')?.[1] || 'Meeting Booking';
    
    // Parse weekly availability from 'sch' tags
    const weeklyAvailability = {};
    event.tags.filter(tag => tag[0] === 'sch').forEach(tag => {
        const [, day, start, end] = tag;
        weeklyAvailability[day] = { start, end };
    });
    
    const durationMinutes = parseDuration(duration);
    const intervalMinutes = parseDuration(interval);
    
    // Parse buffer times separately
    const bufferBeforeMinutes = parseDuration(bufferBefore);
    const bufferAfterMinutes = parseDuration(bufferAfter);
    const totalBufferMinutes = bufferBeforeMinutes + bufferAfterMinutes;
    
    // Parse minimum notice
    const minNoticeMinutes = parseDuration(minNotice);
    
    // Parse maximum advance booking (e.g., P30D = 30 days, P0D = no limit)
    let maxAdvanceDays = null;
    if (maxAdvance) {
        const maxAdvMatch = maxAdvance.match(/P(\d+)D/);
        if (maxAdvMatch) {
            const parsedDays = parseInt(maxAdvMatch[1]);
            // Treat 0 days as unlimited (no constraint)
            maxAdvanceDays = parsedDays === 0 ? null : parsedDays;
        }
    }
    
    console.log('📋 Parsed availability constraints:', {
        duration: durationMinutes + ' minutes',
        interval: intervalMinutes + ' minutes',
        bufferBefore: bufferBeforeMinutes + ' minutes',
        bufferAfter: bufferAfterMinutes + ' minutes',
        totalBuffer: totalBufferMinutes + ' minutes',
        minNotice: minNoticeMinutes + ' minutes',
        maxAdvance: maxAdvanceDays ? maxAdvanceDays + ' days' : 'unlimited',
        location: location
    });
    
    availabilityData = {
        identifier: dTag,
        calendarRef,
        timezone,
        duration: durationMinutes,
        interval: intervalMinutes,
        bufferBefore: bufferBeforeMinutes,
        bufferAfter: bufferAfterMinutes,
        buffer: totalBufferMinutes, // Keep for backward compatibility
        minNotice: minNoticeMinutes,
        maxAdvanceDays: maxAdvanceDays,
        zapAmount: amountSats,
        weeklyAvailability,
        ownerPubkey,
        location,
        title,
        description: event.content
    };
    
    // Update UI
    document.getElementById('eventTitle').textContent = title;
    document.getElementById('eventDuration').textContent = `${durationMinutes} min`;
    document.getElementById('eventTimezone').textContent = timezone;
    document.getElementById('hostAvatar').textContent = ownerPubkey.slice(0, 2).toUpperCase();
    
    // Update description if available
    const descriptionElement = document.getElementById('eventDescription');
    if (descriptionElement && event.content) {
        descriptionElement.textContent = event.content;
        descriptionElement.style.display = 'block';
    } else if (descriptionElement) {
        descriptionElement.style.display = 'none';
    }
    
    // Update event meta with buffer and max advance info
    const eventMeta = document.querySelector('.event-meta');
    if (eventMeta) {
        let metaHTML = `<span>⏱️ <span id="eventDuration">${durationMinutes} min</span></span>`;
        metaHTML += `<span>🌍 <span id="eventTimezone">${timezone}</span></span>`;
        metaHTML += `<span>📍 ${location}</span>`;
        
        if (totalBufferMinutes > 0) {
            metaHTML += `<span>🛡️ ${bufferBeforeMinutes}/${bufferAfterMinutes} min buffer</span>`;
        }
        
        if (minNoticeMinutes > 0) {
            metaHTML += `<span>⏰ ${minNoticeMinutes} min notice</span>`;
        }
        
        if (maxAdvanceDays !== null) {
            metaHTML += `<span>📅 ${maxAdvanceDays} days max advance</span>`;
        }
        
        eventMeta.innerHTML = metaHTML;
    }
    
    if (window.resolveAvailability) {
        window.resolveAvailability();
    }
}

// Helper function to parse ISO-8601 durations
function parseDuration(duration) {
    if (!duration) return 0;
    
    // Handle seconds (PT0S -> 0)
    if (duration.includes('S')) {
        const seconds = parseInt(duration.match(/PT(\d+)S/)?.[1] || '0');
        return Math.floor(seconds / 60); // Convert to minutes
    }
    
    // Handle minutes (PT30M -> 30)
    if (duration.includes('M')) {
        return parseInt(duration.match(/PT(\d+)M/)?.[1] || '0');
    }
    
    // Handle hours (PT1H -> 60)
    if (duration.includes('H')) {
        return parseInt(duration.match(/PT(\d+)H/)?.[1] || '0') * 60;
    }
    
    return 0;
}

async function fetchBusyTimes() {
    const now = Math.floor(Date.now() / 1000);
    const futureTime = now + (90 * 24 * 60 * 60);
    
    const filter = {
        kinds: [31922, 31923, 31925],
        authors: [ownerPubkey],
        since: now - (30 * 24 * 60 * 60),
        until: futureTime,
        limit: 200
    };
    
    const subscriptionId = 'busy-' + Date.now();
    const request = ['REQ', subscriptionId, filter];
    
    relayConnections.forEach((ws, url) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(request));
        }
    });
}

// Enhanced RSVP event processing with deduplication and chronological ordering
function processRSVPEvent(event) {
    console.log('Processing RSVP event:', {
        id: event.id.slice(0, 8) + '...',
        pubkey: event.pubkey.slice(0, 8) + '...',
        isOwnerEvent: event.pubkey === ownerPubkey,
        created_at: event.created_at,
        tags: event.tags.map(t => ({ tag: t[0], value: t[1] }))
    });
    
    // Prevent duplicate processing
    if (processedEventIds.has(event.id)) {
        console.log('Skipping RSVP - already processed:', event.id.slice(0, 8) + '...');
        return;
    }
    processedEventIds.add(event.id);
    
    // Only process RSVPs from the owner
    if (event.pubkey !== ownerPubkey) {
        console.log('Skipping RSVP - not from owner');
        return;
    }
    
    const statusTag = event.tags.find(tag => tag[0] === 'status')?.[1];
    const fbTag = event.tags.find(tag => tag[0] === 'fb')?.[1];
    
    // Extract the referenced event ID
    const eTag = event.tags.find(tag => tag[0] === 'e')?.[1];
    const aTag = event.tags.find(tag => tag[0] === 'a')?.[1];
    
    let referencedEventId = null;
    
    if (eTag) {
        referencedEventId = eTag;
        console.log('Found referenced event ID from e tag:', referencedEventId);
    } else if (aTag) {
        // Extract event ID from a tag format: kind:pubkey:identifier
        const aParts = aTag.split(':');
        if (aParts.length >= 3 && aParts[0] === '31923') {
            console.log('Found a tag reference to 31923:', aTag);
            referencedEventId = aTag;
        }
    }
    
    if (!referencedEventId) {
        console.log('❌ RSVP missing event reference (e or a tag)');
        return;
    }
    
    // Store RSVP in history for chronological processing
    if (!rsvpHistory.has(referencedEventId)) {
        rsvpHistory.set(referencedEventId, []);
    }
    
    const rsvpList = rsvpHistory.get(referencedEventId);
    
    // Check if this specific RSVP is already in history (additional deduplication)
    const existingRSVP = rsvpList.find(r => r.id === event.id);
    if (existingRSVP) {
        console.log('RSVP already in history, skipping');
        return;
    }
    
    // Add to history with enhanced metadata
    const rsvpRecord = {
        id: event.id,
        created_at: event.created_at,
        status: statusTag,
        fb: fbTag,
        content: event.content || '',
        event: event // Store full event for debugging
    };
    
    rsvpList.push(rsvpRecord);
    
    // Sort by creation time (most recent first)
    rsvpList.sort((a, b) => b.created_at - a.created_at);
    
    console.log(`📝 Updated RSVP history for ${referencedEventId.slice(0, 8)}...`, {
        totalRSVPs: rsvpList.length,
        chronologicalOrder: rsvpList.map(r => ({
            id: r.id.slice(0, 8) + '...',
            created_at: new Date(r.created_at * 1000).toLocaleString(),
            status: r.status,
            fb: r.fb,
            content: r.content.slice(0, 50) + (r.content.length > 50 ? '...' : '')
        }))
    });
    
    // Determine the current effective status based on the most recent RSVP
    const effectiveRSVP = getEffectiveRSVP(referencedEventId);
    
    if (effectiveRSVP) {
        console.log(`🎯 Effective RSVP for ${referencedEventId.slice(0, 8)}...:`, {
            id: effectiveRSVP.id.slice(0, 8) + '...',
            status: effectiveRSVP.status,
            fb: effectiveRSVP.fb,
            created_at: new Date(effectiveRSVP.created_at * 1000).toLocaleString(),
            content: effectiveRSVP.content
        });
        
        // Update accepted RSVPs map based on effective status
        if (effectiveRSVP.status === 'accepted' && effectiveRSVP.fb === 'busy') {
            acceptedRSVPs.set(referencedEventId, effectiveRSVP);
            console.log('✅ Updated acceptedRSVPs - booking is confirmed');
        } else {
            // Remove from accepted if status changed to something else
            if (acceptedRSVPs.has(referencedEventId)) {
                acceptedRSVPs.delete(referencedEventId);
                console.log('❌ Removed from acceptedRSVPs - booking no longer confirmed');
                
                // If this affects the currently selected date, refresh time slots
                if (selectedDate) {
                    setTimeout(() => renderTimeSlots(), 100);
                }
            }
        }
    }
}

// New function to get the effective (most recent) RSVP for a booking
function getEffectiveRSVP(referencedEventId) {
    const rsvpList = rsvpHistory.get(referencedEventId);
    if (!rsvpList || rsvpList.length === 0) {
        return null;
    }
    
    // Return the most recent RSVP (list is already sorted by created_at desc)
    return rsvpList[0];
}

// Fetch the actual booking events referenced by accepted RSVPs
async function fetchReferencedBookings() {
    if (acceptedRSVPs.size === 0) {
        console.log('No accepted RSVPs to fetch bookings for');
        return;
    }
    
    console.log('🔍 Fetching referenced booking events for', acceptedRSVPs.size, 'accepted RSVPs');
    
    const eventIds = [];
    const aTagFilters = [];
    
    // Separate direct event IDs from a-tag references
    acceptedRSVPs.forEach((rsvp, reference) => {
        if (reference.startsWith('31923:')) {
            // This is an a-tag reference, need to query by kind+pubkey+d
            const [kind, pubkey, dTag] = reference.split(':');
            aTagFilters.push({ kind: parseInt(kind), pubkey, dTag });
        } else {
            // This is a direct event ID
            eventIds.push(reference);
            pendingBookingFetches.add(reference);
        }
    });
    
    // Fetch by event IDs if we have any
    if (eventIds.length > 0) {
        const idFilter = {
            kinds: [31923],
            ids: eventIds,
            limit: 50
        };
        
        const subscriptionId = 'referenced-bookings-ids-' + Date.now();
        const request = ['REQ', subscriptionId, idFilter];
        
        relayConnections.forEach((ws, url) => {
            if (ws.readyState === WebSocket.OPEN) {
                console.log(`Fetching booking events by ID from ${url}:`, eventIds);
                ws.send(JSON.stringify(request));
            }
        });
    }
    
    // Fetch by a-tag references if we have any
    aTagFilters.forEach(filter => {
        const aFilter = {
            kinds: [filter.kind],
            authors: [filter.pubkey],
            '#d': [filter.dTag],
            limit: 10
        };
        
        const subscriptionId = 'referenced-bookings-a-' + Date.now();
        const request = ['REQ', subscriptionId, aFilter];
        
        pendingBookingFetches.add(`${filter.kind}:${filter.pubkey}:${filter.dTag}`);
        
        relayConnections.forEach((ws, url) => {
            if (ws.readyState === WebSocket.OPEN) {
                console.log(`Fetching booking event by a-tag from ${url}:`, filter);
                ws.send(JSON.stringify(request));
            }
        });
    });
}

// Enhanced busy event processing with proper RSVP conflict resolution
function processBusyEvent(event) {
    console.log('Processing potential busy event:', {
        id: event.id.slice(0, 8) + '...',
        kind: event.kind,
        pubkey: event.pubkey.slice(0, 8) + '...',
        isOwnerEvent: event.pubkey === ownerPubkey,
        created_at: event.created_at,
        tags: event.tags.map(t => ({ tag: t[0], value: t[1] }))
    });
    
    // Prevent duplicate processing
    if (processedEventIds.has(event.id)) {
        console.log('Skipping busy event - already processed:', event.id.slice(0, 8) + '...');
        return;
    }
    processedEventIds.add(event.id);
    
    const startTag = event.tags.find(tag => tag[0] === 'start');
    const endTag = event.tags.find(tag => tag[0] === 'end');
    const aTag = event.tags.find(tag => tag[0] === 'a')?.[1];
    const pTags = event.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]);
    const forTag = event.tags.find(tag => tag[0] === 'for')?.[1];
    const titleTag = event.tags.find(tag => tag[0] === 'title')?.[1] || 'Untitled';
    const dTag = event.tags.find(tag => tag[0] === 'd')?.[1];
    
    const isRelatedToOwner = event.pubkey === ownerPubkey ||
                           pTags.includes(ownerPubkey) ||
                           (forTag && forTag.includes(ownerPubkey)) ||
                           (aTag && aTag.includes(ownerPubkey));
    
    if (!isRelatedToOwner) {
        console.log('Skipping event - not related to owner');
        return;
    }
    
    let shouldBlock = false;
    let reason = '';
    
    // Handle 31922/31923 events per NIP-52 spec
    if (event.kind === 31922 || event.kind === 31923) {
        if (event.pubkey === ownerPubkey) {
            // Owner's calendar events are always busy (actual commitments)
            shouldBlock = true;
            reason = event.kind === 31922 ? 'owner date-based calendar event' : 'owner time-based calendar event';
        } else if (pTags.includes(ownerPubkey)) {
            // Events from others involving owner (booking requests)
            if (event.kind === 31923) {
                // For booking requests, check effective RSVP status using chronological resolution
                const effectiveRSVP = getEffectiveRSVP(event.id) || getEffectiveRSVP(`31923:${event.pubkey}:${dTag}`);
                
                if (effectiveRSVP) {
                    if (effectiveRSVP.status === 'accepted' && effectiveRSVP.fb === 'busy') {
                        shouldBlock = true;
                        reason = `booking request with effective accepted RSVP (${new Date(effectiveRSVP.created_at * 1000).toLocaleString()})`;
                    } else {
                        shouldBlock = false;
                        reason = `booking request with effective ${effectiveRSVP.status} RSVP (${new Date(effectiveRSVP.created_at * 1000).toLocaleString()})`;
                    }
                } else {
                    shouldBlock = false;
                    reason = 'booking request without RSVP response';
                }
            } else if (event.kind === 31922) {
                // Date-based events from others involving owner (rare case)
                shouldBlock = true; // Conservative approach
                reason = 'date-based event involving owner';
            }
        }
    }
    
    // Mark that we've processed this referenced booking
    if (pendingBookingFetches.has(event.id)) {
        pendingBookingFetches.delete(event.id);
        console.log('✅ Processed referenced booking from RSVP');
    }
    
    if (!shouldBlock) {
        console.log(`Skipping event - ${reason}`);
        return;
    }
    
    console.log(`✅ Will process as busy event - ${reason}`);
    
    if (!startTag || !endTag) {
        console.log('Event missing start/end tags, cannot process as busy time');
        return;
    }
    
    let startTime, endTime;
    
    try {
        if (event.kind === 31923) {
            const startUnix = parseInt(startTag[1]);
            const endUnix = parseInt(endTag[1]);
            
            if (isNaN(startUnix) || isNaN(endUnix)) {
                console.error('Invalid Unix timestamps:', { start: startTag[1], end: endTag[1] });
                return;
            }
            
            startTime = new Date(startUnix * 1000);
            endTime = new Date(endUnix * 1000);
        } else if (event.kind === 31922) {
            startTime = new Date(startTag[1] + 'T00:00:00');
            endTime = new Date(endTag[1] + 'T23:59:59');
        }
        
        if (startTime && endTime && !isNaN(startTime.getTime()) && !isNaN(endTime.getTime())) {
            const dateKey = startTime.toISOString().split('T')[0];
            
            if (!busyTimes.has(dateKey)) {
                busyTimes.set(dateKey, []);
            }
            
            // Check if this exact busy slot already exists (additional deduplication)
            const existingSlots = busyTimes.get(dateKey);
            const duplicateSlot = existingSlots.find(slot => 
                slot.eventId === event.id || 
                (slot.start.getTime() === startTime.getTime() && 
                 slot.end.getTime() === endTime.getTime() && 
                 slot.title === titleTag)
            );
            
            if (duplicateSlot) {
                console.log('Busy slot already exists, skipping duplicate');
                return;
            }
            
            const busySlot = { 
                start: startTime, 
                end: endTime, 
                eventId: event.id,
                title: titleTag,
                kind: event.kind,
                reason: reason,
                created_at: event.created_at
            };
            
            existingSlots.push(busySlot);
            
            // Sort busy times by start time for better organization
            existingSlots.sort((a, b) => a.start.getTime() - b.start.getTime());
            
            console.log(`🎯 ADDED BUSY TIME for ${dateKey}:`, {
                title: titleTag,
                start: startTime.toLocaleString(),
                end: endTime.toLocaleString(),
                duration: Math.round((endTime - startTime) / 60000) + ' minutes',
                reason: reason,
                kind: event.kind,
                eventId: event.id.slice(0, 8) + '...'
            });
            
            // Refresh UI if this date is currently selected
            if (selectedDate && selectedDate.toISOString().split('T')[0] === dateKey) {
                console.log('Refreshing time slots due to busy time update');
                setTimeout(() => renderTimeSlots(), 100);
            }
        } else {
            console.error('Invalid start/end times:', { 
                startTime: startTime?.toString(), 
                endTime: endTime?.toString(),
                startTag: startTag[1], 
                endTag: endTag[1] 
            });
        }
    } catch (error) {
        console.error('Error parsing busy event times:', error, { startTag, endTag });
    }
}

// Debug function to inspect RSVP conflicts (useful for troubleshooting)
function debugRSVPConflicts() {
    console.log('🔍 RSVP Conflict Analysis:');
    
    rsvpHistory.forEach((rsvpList, eventId) => {
        if (rsvpList.length > 1) {
            console.log(`📋 Event ${eventId.slice(0, 8)}... has ${rsvpList.length} RSVPs:`);
            
            rsvpList.forEach((rsvp, index) => {
                const isEffective = index === 0; // Most recent is first
                console.log(`  ${isEffective ? '🎯' : '📝'} ${rsvp.id.slice(0, 8)}... - ${rsvp.status}/${rsvp.fb} (${new Date(rsvp.created_at * 1000).toLocaleString()}) ${isEffective ? '[EFFECTIVE]' : ''}`);
                if (rsvp.content) {
                    console.log(`      Content: "${rsvp.content.slice(0, 100)}..."`);
                }
            });
            
            const effective = getEffectiveRSVP(eventId);
            console.log(`  ➡️ Final status: ${effective.status}/${effective.fb}`);
        }
    });
}

function showBookingInterface() {
    console.log('🎨 Attempting to show booking interface...');
    
    const inputSection = document.getElementById('inputSection');
    const bookingInterface = document.getElementById('bookingInterface');
    
    if (!inputSection || !bookingInterface) {
        console.error('❌ Could not find required elements:', {
            inputSection: !!inputSection,
            bookingInterface: !!bookingInterface
        });
        return;
    }
    
    // Hide input section
    inputSection.style.display = 'none';
    console.log('🙈 Hidden input section');
    
    // Show booking interface
    bookingInterface.classList.remove('hidden');
    bookingInterface.style.display = 'block';
    console.log('👁️ Showed booking interface');
    
    console.log('📊 Interface state:', {
        inputSectionDisplay: inputSection.style.display,
        bookingInterfaceDisplay: bookingInterface.style.display,
        bookingInterfaceHidden: bookingInterface.classList.contains('hidden'),
        availabilityData,
        busyTimesCount: busyTimes.size,
        acceptedRSVPsCount: acceptedRSVPs.size
    });
    
    // Render calendar after a short delay to ensure DOM is ready
    setTimeout(() => {
        console.log('🗓️ Rendering calendar...');
        renderCalendar();
        console.log('✅ Calendar rendered');
    }, 100);
}

function goBack() {
    document.getElementById('bookingInterface').style.display = 'none';
    document.getElementById('inputSection').style.display = 'block';
    clearBookingState();
}

function renderCalendar() {
    const calendar = document.getElementById('bookingCalendar');
    const monthYear = document.getElementById('monthYear');
    
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    monthYear.textContent = new Intl.DateTimeFormat('en-US', { 
        month: 'long', 
        year: 'numeric' 
    }).format(currentDate);
    
    // Create calendar structure exactly like the main app
    calendar.innerHTML = '';
    
    // Create the main calendar grid container
    const calendarGrid = document.createElement('div');
    calendarGrid.className = 'calendar-grid';
    
    // Create calendar header
    const calendarHeader = document.createElement('div');
    calendarHeader.className = 'calendar-header';
    
    const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayHeaders.forEach(day => {
        const headerDay = document.createElement('div');
        headerDay.className = 'calendar-header-day';
        headerDay.textContent = day;
        calendarHeader.appendChild(headerDay);
    });
    
    // Create calendar body
    const calendarBody = document.createElement('div');
    calendarBody.className = 'calendar-body';
    
    // Calculate calendar dates
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDate = new Date(firstDay);
    startDate.setDate(startDate.getDate() - firstDay.getDay());
    
    // Generate calendar cells
    for (let i = 0; i < 42; i++) {
        const cellDate = new Date(startDate);
        cellDate.setDate(startDate.getDate() + i);
        
        const isCurrentMonth = cellDate.getMonth() === month;
        const isToday = cellDate.toDateString() === new Date().toDateString();
        const isSelected = selectedDate && cellDate.toDateString() === selectedDate.toDateString();
        const isAvailable = isDateAvailable(cellDate);
        const isPast = cellDate < new Date().setHours(0, 0, 0, 0);
        const isTooEarly = !canBookOnDate(cellDate); // Check minimum notice
        
        const dayCell = document.createElement('div');
        dayCell.className = 'calendar-day';
        
        // Add appropriate classes based on date status
        if (!isCurrentMonth) {
            dayCell.classList.add('other-month');
        } else if (isSelected) {
            dayCell.classList.add('selected');
        } else if (isToday) {
            dayCell.classList.add('today');
        }
        
        // Handle availability and constraints
        if (isPast) {
            dayCell.classList.add('unavailable');
            dayCell.style.cursor = 'not-allowed';
            dayCell.style.opacity = '0.5';
        } else if (isTooEarly) {
            dayCell.classList.add('unavailable');
            dayCell.style.cursor = 'not-allowed';
            dayCell.style.opacity = '0.6';
            dayCell.style.borderLeft = '3px solid #f59e0b'; // Yellow left border for min notice
            dayCell.title = `Requires ${availabilityData.minNotice} minutes advance notice`;
        } else if (!isAvailable) {
            dayCell.classList.add('unavailable');
            dayCell.style.cursor = 'not-allowed';
            dayCell.style.opacity = '0.6';
            
            // Check if it's specifically due to max advance booking
            if (availabilityData?.maxAdvanceDays !== null) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const maxBookingDate = new Date(today);
                maxBookingDate.setDate(today.getDate() + availabilityData.maxAdvanceDays);
                
                if (cellDate > maxBookingDate) {
                    dayCell.style.borderLeft = '3px solid #ef4444'; // Red left border for max advance limit
                    dayCell.title = `Beyond maximum advance booking limit (${availabilityData.maxAdvanceDays} days)`;
                }
            }
        } else {
            // This is an available date - highlight it!
            dayCell.classList.add('available');
            dayCell.style.cursor = 'pointer';
            dayCell.style.backgroundColor = 'rgba(124, 58, 237, 0.1)'; // Light purple background
            dayCell.style.border = '2px solid rgba(124, 58, 237, 0.3)'; // Purple border
            dayCell.style.color = '#a855f7'; // Purple text
            dayCell.style.fontWeight = '600'; // Bold text
            
            // Add hover effect for available dates
            dayCell.addEventListener('mouseenter', () => {
                if (!dayCell.classList.contains('selected')) {
                    dayCell.style.backgroundColor = 'rgba(124, 58, 237, 0.2)';
                    dayCell.style.borderColor = 'rgba(124, 58, 237, 0.5)';
                }
            });
            
            dayCell.addEventListener('mouseleave', () => {
                if (!dayCell.classList.contains('selected')) {
                    dayCell.style.backgroundColor = 'rgba(124, 58, 237, 0.1)';
                    dayCell.style.borderColor = 'rgba(124, 58, 237, 0.3)';
                }
            });
            
            dayCell.addEventListener('click', () => selectDate(cellDate));
        }
        
        // Create day number
        const dayNumber = document.createElement('div');
        dayNumber.className = 'day-number';
        dayNumber.textContent = cellDate.getDate();
        
        dayCell.appendChild(dayNumber);
        calendarBody.appendChild(dayCell);
    }
    
    // Assemble the calendar
    calendarGrid.appendChild(calendarHeader);
    calendarGrid.appendChild(calendarBody);
    calendar.appendChild(calendarGrid);
    
    console.log('✅ Calendar rendered with availability highlighting');
}

function isDateAvailable(date) {
    if (!availabilityData) return false;
    
    const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; // ISO-8601 day codes
    const dayKey = dayNames[date.getDay()];
    
    // Check if this day has defined availability hours
    if (!availabilityData.weeklyAvailability[dayKey]) {
        return false;
    }
    
    // Check maximum advance booking constraint
    if (availabilityData.maxAdvanceDays !== null) {
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Start of today
        
        const maxBookingDate = new Date(today);
        maxBookingDate.setDate(today.getDate() + availabilityData.maxAdvanceDays);
        
        if (date > maxBookingDate) {
            console.log(`Date ${date.toISOString().split('T')[0]} exceeds max advance booking of ${availabilityData.maxAdvanceDays} days`);
            return false;
        }
    }
    
    return true;
}

// Check if we can book on this date considering minimum notice
function canBookOnDate(date) {
    if (!availabilityData || !availabilityData.minNotice) return true;
    
    const now = new Date();
    const earliestBookingTime = new Date(now.getTime() + (availabilityData.minNotice * 60 * 1000));
    
    // For date selection, we check if ANY slot on this date would be bookable
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    return endOfDay >= earliestBookingTime;
}

function selectDate(date) {
    selectedDate = date;
    selectedTime = null;
    renderCalendar();
    renderTimeSlots();
    
    const dateStr = date.toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric' 
    });
    document.getElementById('selectedDate').textContent = dateStr;
    
    document.getElementById('bookBtn').classList.add('hidden');
}

function renderTimeSlots() {
    const container = document.getElementById('timeSlots');
    
    if (!selectedDate || !availabilityData) {
        container.innerHTML = '<div class="no-times">👈 Select a date to see available times</div>';
        return;
    }
    
    const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; // ISO-8601 day codes
    const dayKey = dayNames[selectedDate.getDay()];
    const dayAvailability = availabilityData.weeklyAvailability[dayKey];
    
    if (!dayAvailability) {
        container.innerHTML = '<div class="no-times">No availability on this day</div>';
        return;
    }
    
    const timeSlots = generateTimeSlots(selectedDate, dayAvailability);
    
    if (timeSlots.length === 0) {
        container.innerHTML = '<div class="no-times">No available times</div>';
        return;
    }
    
    container.innerHTML = '';
    timeSlots.forEach(slot => {
        const button = document.createElement('button');
        button.className = 'time-slot';
        button.textContent = slot.display;
        button.onclick = () => selectTimeSlot(slot);
        
        if (slot.available) {
            if (selectedTime && selectedTime.start.getTime() === slot.start.getTime()) {
                button.classList.add('selected');
            }
        } else {
            button.disabled = true;
        }
        
        container.appendChild(button);
    });
}

function generateTimeSlots(date, dayAvailability) {
    const slots = [];
    const { start, end } = dayAvailability;
    const duration = availabilityData.duration;
    const interval = availabilityData.interval || duration; // Use interval if specified
    
    const [startHour, startMin] = start.split(':').map(Number);
    const [endHour, endMin] = end.split(':').map(Number);
    
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;
    
    for (let minutes = startMinutes; minutes < endMinutes; minutes += interval) {
        if (minutes + duration > endMinutes) break;
        
        const hour = Math.floor(minutes / 60);
        const min = minutes % 60;
        
        const slotStart = new Date(date);
        slotStart.setHours(hour, min, 0, 0);
        
        const slotEnd = new Date(slotStart);
        slotEnd.setMinutes(slotEnd.getMinutes() + duration);
        
        const now = new Date();
        const minBookingTime = new Date(now.getTime() + (availabilityData.minNotice * 60 * 1000));
        
        const isPast = slotStart <= now;
        const isTooSoon = slotStart < minBookingTime;
        const isConflicted = isTimeConflicted(slotStart, slotEnd);
        
        slots.push({
            start: slotStart,
            end: slotEnd,
            display: formatTime(hour, min),
            available: !isPast && !isTooSoon && !isConflicted
        });
    }
    
    return slots;
}

function isTimeConflicted(slotStart, slotEnd) {
    const dateKey = slotStart.toISOString().split('T')[0];
    const dayBusyTimes = busyTimes.get(dateKey) || [];
    
    console.log(`Checking conflicts for ${slotStart.toLocaleTimeString()} - ${slotEnd.toLocaleTimeString()} on ${dateKey}`);
    console.log(`Found ${dayBusyTimes.length} busy periods for this date:`, 
        dayBusyTimes.map(bt => ({ 
            start: bt.start.toLocaleTimeString(), 
            end: bt.end.toLocaleTimeString(),
            eventId: bt.eventId?.slice(0, 8) + '...',
            reason: bt.reason
        }))
    );
    
    const bufferBeforeMinutes = availabilityData?.bufferBefore || 0;
    const bufferAfterMinutes = availabilityData?.bufferAfter || 0;
    
    const hasConflict = dayBusyTimes.some(busy => {
        // Apply buffer time to busy periods
        const bufferedStart = new Date(busy.start.getTime() - (bufferAfterMinutes * 60 * 1000));
        const bufferedEnd = new Date(busy.end.getTime() + (bufferBeforeMinutes * 60 * 1000));
        
        const overlaps = (slotStart < bufferedEnd && slotEnd > bufferedStart);
        
        if (overlaps) {
            if (bufferBeforeMinutes > 0 || bufferAfterMinutes > 0) {
                console.log(`CONFLICT: Slot ${slotStart.toLocaleTimeString()}-${slotEnd.toLocaleTimeString()} conflicts with busy ${busy.start.toLocaleTimeString()}-${busy.end.toLocaleTimeString()} (${busy.reason}) + ${bufferBeforeMinutes}/${bufferAfterMinutes}min buffer`);
            } else {
                console.log(`CONFLICT: Slot ${slotStart.toLocaleTimeString()}-${slotEnd.toLocaleTimeString()} overlaps with busy ${busy.start.toLocaleTimeString()}-${busy.end.toLocaleTimeString()} (${busy.reason})`);
            }
        }
        return overlaps;
    });
    
    return hasConflict;
}

function formatTime(hour, min) {
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const displayMin = min.toString().padStart(2, '0');
    return `${displayHour}:${displayMin} ${period}`;
}

function selectTimeSlot(slot) {
    if (!slot.available) return;
    
    selectedTime = slot;
    renderTimeSlots();
    
    document.getElementById('bookBtn').classList.remove('hidden');
}

async function confirmBooking() {
    if (!selectedTime || !selectedDate) {
        showError('Please select a date and time first.');
        return;
    }
    
    if (availabilityData.zapAmount && availabilityData.zapAmount > 0) {
        const confirmZap = confirm(`This booking requires a ${availabilityData.zapAmount} sats zap. Do you want to proceed? (Note: Zap functionality not implemented in this demo)`);
        if (!confirmZap) {
            return;
        }
    }
    
    try {
        // Check if window.nostr is available
        if (!window.nostr) {
            showBookingStatus('Please connect with Nostr to make a booking.', 'error');
            
            // Launch nostr-login modal
            document.dispatchEvent(new CustomEvent('nlLaunch', { detail: 'welcome' }));
            
            // Wait for authentication
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Authentication timeout'));
                }, 30000);
                
                const handleAuth = (e) => {
                    if (e.detail.type === 'login' || e.detail.type === 'signup') {
                        clearTimeout(timeout);
                        document.removeEventListener('nlAuth', handleAuth);
                        resolve();
                    }
                };
                
                document.addEventListener('nlAuth', handleAuth);
            });
        }
        
        showBookingStatus('Creating booking request...', 'loading');
        
        const event = await createBookingEvent();
        
        showBookingStatus('✅ Booking request sent successfully! The host will receive your request and can accept or decline it.', 'success');
        
        setTimeout(() => {
            goBack();
        }, 5000);
        
    } catch (error) {
        console.error('Error creating booking:', error);
        let errorMessage = 'Failed to create booking: ' + error.message;
        if (error.message.includes('rejected')) {
            errorMessage += '\n\nThis might be due to:\n• Relay restrictions on calendar events\n• Invalid event format\n• Network issues\n\nTry different relays or check with the host.';
        }
        showBookingStatus('❌ ' + errorMessage, 'error');
    }
}

async function createBookingEvent() {
    const bookerPubkey = await window.nostr.getPublicKey();
    
    const startTimestamp = Math.floor(selectedTime.start.getTime() / 1000);
    const endTimestamp = Math.floor(selectedTime.end.getTime() / 1000);
    
    // Create NIP-52 compliant 31923 time-based calendar event
    const bookingEvent = {
        kind: 31923,
        pubkey: bookerPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            // Required tags per NIP-52
            ['d', `booking-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`],
            ['title', 'Meeting Request'],
            ['start', startTimestamp.toString()],
            ['end', endTimestamp.toString()],
            
            // Optional tags per NIP-52
            ['summary', `Booking request from ${bookerPubkey.slice(0, 8)}...`],
            ['start_tzid', availabilityData.timezone],
            ['end_tzid', availabilityData.timezone],
            ['location', availabilityData.location || 'Online Meeting'],
            
            // Participants (owner as attendee, booker as organizer)
            ['p', ownerPubkey, '', 'attendee'],
            ['p', bookerPubkey, '', 'organizer'],
            
            // Reference to availability template that created this booking
            ['a', `31926:${ownerPubkey}:${availabilityData.identifier}`],
            
            // Categorization
            ['t', 'booking-request'],
        ],
        content: `Meeting request for ${selectedTime.display} on ${selectedDate.toLocaleDateString()}. ${availabilityData.description || ''}`
    };
    
    console.log('Creating NIP-52 compliant 31923 booking event:', bookingEvent);
    
    const signedEvent = await window.nostr.signEvent(bookingEvent);
    console.log('Signed booking event:', signedEvent);
    
    const publishPromises = [];
    relayConnections.forEach((ws, url) => {
        if (ws.readyState === WebSocket.OPEN) {
            publishPromises.push(new Promise((resolve, reject) => {
                const eventMessage = ['EVENT', signedEvent];
                
                const originalOnMessage = ws.onmessage;
                const timeout = setTimeout(() => {
                    console.log(`Timeout waiting for OK from ${url}`);
                    ws.onmessage = originalOnMessage;
                    resolve({ relay: url, status: 'timeout' });
                }, 5000);
                
                ws.onmessage = (event) => {
                    const message = JSON.parse(event.data);
                    if (message[0] === 'OK' && message[1] === signedEvent.id) {
                        clearTimeout(timeout);
                        ws.onmessage = originalOnMessage;
                        console.log(`OK response from ${url}:`, message);
                        resolve({ 
                            relay: url, 
                            status: message[2] ? 'accepted' : 'rejected',
                            reason: message[3] || ''
                        });
                    } else {
                        if (originalOnMessage) originalOnMessage(event);
                    }
                };
                
                try {
                    console.log(`Publishing booking to ${url}`);
                    ws.send(JSON.stringify(eventMessage));
                } catch (sendError) {
                    clearTimeout(timeout);
                    ws.onmessage = originalOnMessage;
                    console.error(`Failed to send to ${url}:`, sendError);
                    resolve({ relay: url, status: 'error', error: sendError.message });
                }
            }));
        }
    });
    
    const results = await Promise.allSettled(publishPromises);
    console.log('Publish results:', results);
    
    const acceptedRelays = results
        .filter(r => r.status === 'fulfilled' && r.value.status === 'accepted')
        .map(r => r.value.relay);
            
    const rejectedRelays = results
        .filter(r => r.status === 'fulfilled' && r.value.status === 'rejected')
        .map(r => ({ relay: r.value.relay, reason: r.value.reason }));
    
    if (acceptedRelays.length === 0 && rejectedRelays.length > 0) {
        console.error('All relays rejected the event:', rejectedRelays);
        throw new Error(`Event rejected by relays: ${rejectedRelays.map(r => `${r.relay} (${r.reason})`).join(', ')}`);
    }
    
    console.log(`Event accepted by ${acceptedRelays.length} relays:`, acceptedRelays);
    if (rejectedRelays.length > 0) {
        console.warn('Some relays rejected the event:', rejectedRelays);
    }
    
    return signedEvent;
}

function previousMonth() {
    currentDate.setMonth(currentDate.getMonth() - 1);
    selectedDate = null;
    selectedTime = null;
    renderCalendar();
    document.getElementById('timeSlots').innerHTML = '<div class="no-times">👈 Select a date to see available times</div>';
    document.getElementById('selectedDate').textContent = 'Select a date';
    document.getElementById('bookBtn').classList.add('hidden');
}

function nextMonth() {
    currentDate.setMonth(currentDate.getMonth() + 1);
    selectedDate = null;
    selectedTime = null;
    renderCalendar();
    document.getElementById('timeSlots').innerHTML = '<div class="no-times">👈 Select a date to see available times</div>';
    document.getElementById('selectedDate').textContent = 'Select a date';
    document.getElementById('bookBtn').classList.add('hidden');
}

function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
}

function hideMessages() {
    document.getElementById('errorMessage').classList.add('hidden');
    document.getElementById('bookingStatus').classList.add('hidden');
}

function showLoading(show) {
    const loadingDiv = document.getElementById('loadingMessage');
    const loadBtn = document.getElementById('loadBtn');
    
    if (show) {
        loadingDiv.classList.remove('hidden');
        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading...';
    } else {
        loadingDiv.classList.add('hidden');
        loadBtn.disabled = false;
        loadBtn.textContent = 'Load Availability';
    }
}

function showBookingStatus(message, type) {
    const statusDiv = document.getElementById('bookingStatus');
    
    if (type === 'loading') {
        statusDiv.innerHTML = `<div class="loading"><div class="spinner"></div>${message}</div>`;
    } else if (type === 'success') {
        statusDiv.innerHTML = `<div class="success">${message}</div>`;
    } else if (type === 'error') {
        const formattedMessage = message.replace(/\n/g, '<br>');
        statusDiv.innerHTML = `<div class="error">${formattedMessage}</div>`;
    }
    
    statusDiv.classList.remove('hidden');
    
    if (type === 'error') {
        setTimeout(() => {
            statusDiv.classList.add('hidden');
        }, 10000);
    } else if (type === 'success') {
        setTimeout(() => {
            statusDiv.classList.add('hidden');
        }, 5000);
    }
}

// Update the URL generation in your main app to create shareable links
window.generateShareableBookingLink = function(template) {
    const naddr = `naddr1${template.ownerPubkey.slice(0, 8)}31926${template.id}`;
    return `${window.location.origin}/booking.html?naddr=nostr:${naddr}`;
};