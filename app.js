// Global state
let userPubkey = '';
let calendars = []; // 31924 calendar objects
let currentCalendarId = 'cal-main'; // Track selected calendar
let availabilityTemplates = []; // 31926 availability templates
let bookingRequests = []; // 31923 slot proposals from bookers
let calendarEvents = []; // 31923 confirmed events with fb=busy
let rsvpEvents = []; // 31925 RSVP lifecycle events
let dateBasedEvents = []; // 31922 date-based calendar events
let ownerEvents = []; // 31923 events created by the owner
let currentPage = 'event-slots';
let relays = ['wss://relay.nostrcal.com', 'wss://filter.nostrcal.com'];
let relayConnections = new Map();
let currentEditingTemplate = null;
let modalStep = 1;
let currentBookingTab = 'upcoming';
let processedEvents = new Set(); // Track processed event IDs to prevent duplicates

// Calendar state - Updated to include invalid-requests
let currentCalendarDate = new Date();
let activeEventTypes = new Set(['booking-requests', 'confirmed-meetings', 'owner-events', 'all-day-events', 'invalid-requests']);
let allCalendarEvents = [];

// Updated day mapping for ISO-8601 compliance
// JavaScript getDay(): 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
// ISO-8601 day codes: SU, MO, TU, WE, TH, FR, SA
const dayKeys = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; // Index matches JS getDay()
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Initialize nostr-login with proper loading check
document.addEventListener('DOMContentLoaded', function() {
    // Wait for nostr-login to be available
    function initializeNostrLogin() {
        if (typeof window.nostrLogin === 'undefined') {
            // If nostr-login isn't loaded yet, wait 100ms and try again
            setTimeout(initializeNostrLogin, 100);
            return;
        }
        
        console.log('nostr-login library loaded successfully');
        
        // Set up the connect button to launch nostr-login
        const connectBtn = document.getElementById('connectBtn');
        if (connectBtn) {
            connectBtn.addEventListener('click', async () => {
                try {
                    await window.nostrLogin.launch();
                } catch (error) {
                    console.error('Error launching nostr-login:', error);
                }
            });
        }
        
        // Listen for authentication events
        document.addEventListener('nlAuth', async (e) => {
            console.log('nlAuth event received:', e.detail);
            if (e.detail.type === 'login' || e.detail.type === 'signup') {
                await handleNostrLogin();
            } else if (e.detail.type === 'logout') {
                handleNostrLogout();
            }
        });
        
        // Check if already authenticated
        if (window.nostrLogin && window.nostrLogin.isAuthenticated && window.nostrLogin.isAuthenticated()) {
            console.log('User already authenticated');
            handleNostrLogin();
        }
    }
    
    // Start the initialization process
    initializeNostrLogin();
});

// Handle successful nostr login
async function handleNostrLogin() {
    try {
        // Get the public key using window.nostr
        userPubkey = await window.nostr.getPublicKey();
        console.log('Connected with pubkey:', userPubkey);
        document.getElementById('userPubkey').textContent = userPubkey.slice(0, 20) + '...';
        
        // Hide homepage and show app
        document.getElementById('homepage').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        
        // Connect to relays and load data
        await initializeRelays();
        await loadCalendars();
        
        // Wait a moment for calendars to load, then create default if needed
        setTimeout(async () => {
            await createDefaultCalendar();
            await loadAvailabilityTemplates();
            await loadBookingRequests();
        }, 2500);
        
    } catch (error) {
        console.error('Error connecting to Nostr:', error);
        alert('Error connecting to Nostr. Please try again.');
    }
}

// Handle nostr logout
function handleNostrLogout() {
    console.log('User logged out');
    
    // Reset state
    userPubkey = '';
    calendars = [];
    availabilityTemplates = [];
    bookingRequests = [];
    calendarEvents = [];
    rsvpEvents = [];
    dateBasedEvents = [];
    ownerEvents = [];
    
    // Close relay connections
    relayConnections.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });
    relayConnections.clear();
    
    // Show homepage and hide app
    document.getElementById('app').classList.add('hidden');
    document.getElementById('homepage').classList.remove('hidden');
    
    // Reset pubkey display
    document.getElementById('userPubkey').textContent = 'Loading...';
}

// Legacy connection function for backward compatibility
async function connectNostr() {
    // This is now handled by nostr-login's launch method
    // The button click is handled in the DOMContentLoaded event
}

// Logout function
function logout() {
    if (window.nostrLogin && window.nostrLogin.logout) {
        window.nostrLogin.logout();
    } else {
        // Fallback: dispatch logout event
        document.dispatchEvent(new Event("nlLogout"));
    }
}

// Relay management
async function initializeRelays() {
    const promises = relays.map(relay => connectToRelay(relay));
    await Promise.allSettled(promises);
}

function connectToRelay(relayUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(relayUrl);
        
        ws.onopen = () => {
            console.log(`Connected to ${relayUrl}`);
            relayConnections.set(relayUrl, ws);
            resolve(ws);
        };
        
        ws.onerror = (error) => {
            console.error(`Failed to connect to ${relayUrl}:`, error);
            reject(error);
        };
        
        ws.onmessage = (event) => {
            handleRelayMessage(relayUrl, JSON.parse(event.data));
        };
        
        // Timeout after 5 seconds
        setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                ws.close();
                reject(new Error('Connection timeout'));
            }
        }, 5000);
    });
}

function handleRelayMessage(relayUrl, message) {
    const [type, ...data] = message;
    
    if (type === 'EVENT') {
        const [subscriptionId, event] = data;
        
        if (event.kind === 31924 && event.pubkey === userPubkey) {
            // Process calendar definitions
            processCalendar(event);
        } else if (event.kind === 31926 && event.pubkey === userPubkey) {
            // Process availability templates
            processAvailabilityTemplate(event);
        } else if (event.kind === 31922) {
            // Process date-based calendar events
            processDateBasedEvent(event);
        } else if (event.kind === 31923) {
            // Process time-based calendar events
            processTimeBasedEvent(event);
        } else if (event.kind === 31925) {
            // Process RSVP lifecycle events
            const pTag = event.tags.find(tag => tag[0] === 'p')?.[1];
            
            if (pTag === userPubkey || event.pubkey === userPubkey) {
                console.log('→ Processing RSVP event');
                processRSVPEvent(event);
            }
        }
    }
}

// Load calendars from relays
async function loadCalendars() {
    calendars = [];
    
    // Query for calendars (31924)
    const calendarFilter = {
        kinds: [31924],
        authors: [userPubkey]
    };
    
    const subscriptionId = 'calendars-' + Date.now();
    const reqMessage = ['REQ', subscriptionId, calendarFilter];
    
    console.log('Loading calendars with filter:', calendarFilter);
    
    // Send to all connected relays
    relayConnections.forEach((ws, relayUrl) => {
        if (ws.readyState === WebSocket.OPEN) {
            console.log(`Querying calendars from ${relayUrl}`);
            ws.send(JSON.stringify(reqMessage));
        }
    });
    
    // Wait a bit for responses, then update selector
    setTimeout(() => {
        console.log('Loaded calendars:', calendars);
        
        // If we have calendars and no current selection, use the first one
        if (calendars.length > 0 && !calendars.find(cal => cal.id === currentCalendarId)) {
            currentCalendarId = calendars[0].id;
            console.log('Set current calendar to:', currentCalendarId);
        }
        
        updateCalendarSelector();
    }, 2000);
}

// Create default calendar if none exist
async function createDefaultCalendar() {
    // Only create if no calendars exist
    if (calendars.length > 0) {
        console.log('Calendars already exist, skipping default creation');
        currentCalendarId = calendars[0].id; // Use first available calendar
        updateCalendarSelector();
        return;
    }
    
    try {
        const calendarEvent = {
            kind: 31924,
            pubkey: userPubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', currentCalendarId],
                ['title', 'Main Calendar']
            ],
            content: 'My main booking calendar for meetings and consultations.'
        };
        const signedEvent = await window.nostr.signEvent(calendarEvent);
        
        // Publish to relays
        relayConnections.forEach((ws, relayUrl) => {
            if (ws.readyState === WebSocket.OPEN) {
                const eventMessage = ['EVENT', signedEvent];
                ws.send(JSON.stringify(eventMessage));
                console.log(`Published default calendar to ${relayUrl}`);
            }
        });
        
        // Add to local state
        calendars.push({
            id: currentCalendarId,
            title: 'Main Calendar',
            description: 'My main booking calendar for meetings and consultations.',
            event: signedEvent
        });
        updateCalendarSelector();
        console.log('Created default calendar');
        
    } catch (error) {
        console.error('Error creating default calendar:', error);
    }
}

// Update calendar selector dropdown
function updateCalendarSelector() {
    const selector = document.getElementById('calendarSelector');
    if (!selector) return;
    
    // Clear existing options
    selector.innerHTML = '';
    
    // Add calendars
    calendars.forEach(calendar => {
        const option = document.createElement('option');
        option.value = calendar.id;
        option.textContent = calendar.title;
        if (calendar.id === currentCalendarId) {
            option.selected = true;
        }
        selector.appendChild(option);
    });
    
    // Add "Create New Calendar" option
    const createOption = document.createElement('option');
    createOption.value = 'CREATE_NEW';
    createOption.textContent = '+ Create New Calendar';
    createOption.style.fontStyle = 'italic';
    createOption.style.color = '#a855f7';
    selector.appendChild(createOption);
    
    // If no calendars exist, show create option as selected
    if (calendars.length === 0) {
        createOption.selected = true;
    }
}

// Handle calendar selection
function switchCalendar(selectedValue) {
    if (selectedValue === 'CREATE_NEW') {
        createNewCalendar();
        return;
    }
    
    if (selectedValue && selectedValue !== currentCalendarId) {
        currentCalendarId = selectedValue;
        console.log('Switched to calendar:', currentCalendarId);
        
        // Reload data for the selected calendar
        loadAvailabilityTemplates();
        loadBookingRequests();
    }
}

// Create new calendar
async function createNewCalendar() {
    const title = prompt('Enter a name for your new calendar:');
    if (!title || !title.trim()) {
        // Reset selector to previous value
        updateCalendarSelector();
        return;
    }
    
    try {
        const calendarId = 'cal-' + Date.now().toString(36);
        
        const calendarEvent = {
            kind: 31924,
            pubkey: userPubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', calendarId],
                ['title', title.trim()]
            ],
            content: `Calendar for ${title.trim()}`
        };
        const signedEvent = await window.nostr.signEvent(calendarEvent);
        
        // Publish to relays
        const promises = [];
        relayConnections.forEach((ws, relayUrl) => {
            if (ws.readyState === WebSocket.OPEN) {
                promises.push(new Promise((resolve) => {
                    const eventMessage = ['EVENT', signedEvent];
                    ws.send(JSON.stringify(eventMessage));
                    console.log(`Published new calendar to ${relayUrl}`);
                    setTimeout(resolve, 1000);
                }));
            }
        });
        await Promise.allSettled(promises);
        
        // Add to local state
        const newCalendar = {
            id: calendarId,
            title: title.trim(),
            description: `Calendar for ${title.trim()}`,
            event: signedEvent
        };
        
        calendars.push(newCalendar);
        currentCalendarId = calendarId;
        
        // Update the selector
        updateCalendarSelector();
        
        console.log('Created new calendar:', newCalendar);
        alert(`Calendar "${title.trim()}" created successfully!`);
        
    } catch (error) {
        console.error('Error creating calendar:', error);
        alert('Failed to create calendar. Please try again.');
        updateCalendarSelector(); // Reset selector
    }
}

// Process calendar events (31924)
function processCalendar(event) {
    try {
        // Prevent duplicate processing
        if (processedEvents.has(event.id)) {
            console.log(`⚠️ Event ${event.id} already processed, skipping`);
            return;
        }
        processedEvents.add(event.id);
        
        const dTag = event.tags.find(tag => tag[0] === 'd')?.[1];
        const title = event.tags.find(tag => tag[0] === 'title')?.[1] || 'Untitled Calendar';
        
        if (!dTag) {
            console.log('Invalid calendar - missing d tag');
            return;
        }
        
        const calendar = {
            id: dTag,
            title,
            description: event.content,
            event
        };
        
        // Update or add to calendars
        const existingIndex = calendars.findIndex(cal => cal.id === dTag);
        if (existingIndex >= 0) {
            calendars[existingIndex] = calendar;
        } else {
            calendars.push(calendar);
        }
        console.log('Processed calendar:', calendar);
        
    } catch (error) {
        console.error('Error processing calendar:', error);
    }
}

// Process date-based calendar events (kind 31922)
function processDateBasedEvent(event) {
    try {
        console.log('Processing date-based event (31922):', event);
        
        // Prevent duplicate processing
        if (processedEvents.has(event.id)) {
            console.log(`⚠️ Event ${event.id} already processed, skipping`);
            return;
        }
        processedEvents.add(event.id);
        
        const dTag = event.tags.find(tag => tag[0] === 'd')?.[1];
        const title = event.tags.find(tag => tag[0] === 'title')?.[1] || 'All-Day Event';
        const startDate = event.tags.find(tag => tag[0] === 'start')?.[1]; // YYYY-MM-DD
        const endDate = event.tags.find(tag => tag[0] === 'end')?.[1]; // YYYY-MM-DD
        const location = event.tags.find(tag => tag[0] === 'location')?.[1];
        
        if (!dTag || !startDate) {
            console.log('Invalid date-based event - missing required tags');
            return;
        }

        // Parse ISO dates to timestamps for UI consistency
        const startTime = new Date(startDate + 'T00:00:00').getTime();
        const endTime = endDate 
            ? new Date(endDate + 'T23:59:59').getTime() 
            : new Date(startDate + 'T23:59:59').getTime();

        const dateBasedEvent = {
            id: event.id,
            dTag,
            title,
            startTime,
            endTime,
            location,
            description: event.content,
            type: '31922',
            isAllDay: true,
            createdAt: event.created_at,
            event
        };
        
        // Update or add to dateBasedEvents
        const existingIndex = dateBasedEvents.findIndex(evt => evt.dTag === dTag);
        if (existingIndex >= 0) {
            dateBasedEvents[existingIndex] = dateBasedEvent;
        } else {
            dateBasedEvents.push(dateBasedEvent);
        }
        console.log('Processed date-based event:', dateBasedEvent);
        
        // Update calendar view if we're on the calendar page
        if (currentPage === 'calendar') {
            updateCalendarView();
        }
        
    } catch (error) {
        console.error('Error processing date-based event:', error);
    }
}

// Process time-based calendar events (kind 31923)
function processTimeBasedEvent(event) {
    try {
        console.log('Processing time-based event (31923):', event);
        
        // Prevent duplicate processing
        if (processedEvents.has(event.id)) {
            console.log(`⚠️ Event ${event.id} already processed, skipping`);
            return;
        }
        processedEvents.add(event.id);
        
        const dTag = event.tags.find(tag => tag[0] === 'd')?.[1];
        const title = event.tags.find(tag => tag[0] === 'title')?.[1] || 'Meeting';
        const startTimestamp = event.tags.find(tag => tag[0] === 'start')?.[1];
        const endTimestamp = event.tags.find(tag => tag[0] === 'end')?.[1];
        const location = event.tags.find(tag => tag[0] === 'location')?.[1];
        const pTags = event.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]);
        
        if (!dTag || !startTimestamp) {
            console.log('Invalid time-based event - missing required tags');
            return;
        }

        const timeBasedEvent = {
            id: event.id,
            dTag,
            title,
            startTime: parseInt(startTimestamp) * 1000,
            endTime: endTimestamp ? parseInt(endTimestamp) * 1000 : parseInt(startTimestamp) * 1000 + (60 * 60 * 1000),
            location,
            description: event.content,
            type: '31923',
            participants: pTags,
            bookerPubkey: event.pubkey,
            isAllDay: false,
            createdAt: event.created_at,
            event
        };

        // Route to appropriate array based on author and participants
        if (event.pubkey === userPubkey) {
            // This is an event created by the owner
            const existingIndex = ownerEvents.findIndex(evt => evt.dTag === dTag);
            if (existingIndex >= 0) {
                ownerEvents[existingIndex] = timeBasedEvent;
            } else {
                ownerEvents.push(timeBasedEvent);
            }
            console.log('Added owner event:', timeBasedEvent);
        } else if (pTags.includes(userPubkey)) {
            // This is a booking request TO us
            const request = {
                id: event.id,
                dTag,
                templateRef: event.tags.find(tag => tag[0] === 'a')?.[1],
                bookerPubkey: event.pubkey,
                ownerPubkey: userPubkey,
                title,
                startTime: parseInt(startTimestamp) * 1000,
                endTime: endTimestamp ? parseInt(endTimestamp) * 1000 : parseInt(startTimestamp) * 1000 + (30 * 60 * 1000),
                description: event.content,
                status: 'pending',
                createdAt: event.created_at,
                event
            };

            const existingIndex = bookingRequests.findIndex(req => req.id === event.id);
            if (existingIndex >= 0) {
                bookingRequests[existingIndex] = request;
            } else {
                bookingRequests.push(request);
            }
            console.log('Added booking request:', request);
        }

        if (currentPage === 'calendar' || currentPage === 'bookings') {
            updateCalendarView();
            if (currentPage === 'bookings') renderBookings();
        }
        
    } catch (error) {
        console.error('Error processing time-based event:', error);
    }
}

// Process availability templates (kind 31926) - Updated for NIP-52 compliance
function processAvailabilityTemplate(event) {
    try {
        // Prevent duplicate processing
        if (processedEvents.has(event.id)) {
            console.log(`⚠️ Event ${event.id} already processed, skipping`);
            return;
        }
        processedEvents.add(event.id);
        
        const dTag = event.tags.find(tag => tag[0] === 'd')?.[1];
        const aTag = event.tags.find(tag => tag[0] === 'a')?.[1]; // Points to calendar
        const title = event.tags.find(tag => tag[0] === 'title')?.[1] || 'Untitled Template';
        const description = event.content || '';
        const duration = event.tags.find(tag => tag[0] === 'duration')?.[1] || 'PT30M';
        const interval = event.tags.find(tag => tag[0] === 'interval')?.[1] || duration;
        const tzid = event.tags.find(tag => tag[0] === 'tzid')?.[1] || 'UTC';
        const amountSats = event.tags.find(tag => tag[0] === 'amount_sats')?.[1] || '0';
        const bufferBefore = event.tags.find(tag => tag[0] === 'buffer_before')?.[1] || 'PT0S';
        const bufferAfter = event.tags.find(tag => tag[0] === 'buffer_after')?.[1] || 'PT0S';
        const minNotice = event.tags.find(tag => tag[0] === 'min_notice')?.[1] || 'PT0S';
        const maxAdvance = event.tags.find(tag => tag[0] === 'max_advance')?.[1] || 'P30D';
        const maxAdvanceBusiness = event.tags.find(tag => tag[0] === 'max_advance_business')?.[1] || 'false';
        
        // Parse durations (PT30M -> 30, PT5M -> 5, PT0S -> 0)
        const durationMinutes = parseDuration(duration);
        const intervalMinutes = parseDuration(interval);
        const bufferBeforeMinutes = parseDuration(bufferBefore);
        const bufferAfterMinutes = parseDuration(bufferAfter);
        const minNoticeMinutes = parseDuration(minNotice);
        
        // Parse max advance (P30D -> 30, P0D -> 0 for unlimited)
        const maxAdvanceDays = parseAdvancePeriod(maxAdvance);
        
        // Parse availability from 'sch' tags
        const availability = parseAvailabilityTags(event.tags);
        
        const template = {
            id: dTag,
            calendarRef: aTag,
            title,
            description,
            duration: durationMinutes,
            interval: intervalMinutes,
            timezone: tzid,
            zapAmount: parseInt(amountSats),
            bufferBefore: bufferBeforeMinutes,
            bufferAfter: bufferAfterMinutes,
            minNotice: minNoticeMinutes,
            maxAdvance: maxAdvanceDays,
            maxAdvanceBusiness: maxAdvanceBusiness === 'true',
            availability,
            event: event // Store the full event for editing
        };
        
        // Update or add to availabilityTemplates
        const existingIndex = availabilityTemplates.findIndex(t => t.id === dTag);
        if (existingIndex >= 0) {
            availabilityTemplates[existingIndex] = template;
        } else {
            availabilityTemplates.push(template);
        }
        
        renderAvailabilityTemplates();
    } catch (error) {
        console.error('Error processing availability template:', error);
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

// Helper function to parse advance periods
function parseAdvancePeriod(period) {
    if (!period) return 30;
    
    // Handle days (P30D -> 30, P0D -> 0)
    const days = parseInt(period.match(/P(\d+)D/)?.[1] || '30');
    return days;
}

// Updated to parse 'sch' tags instead of 'w' tags for NIP-52 compliance
function parseAvailabilityTags(tags) {
    const availability = getDefaultAvailability();
    
    // First, disable all days
    Object.keys(availability).forEach(day => {
        availability[day].enabled = false;
    });
    
    // Then enable days that have 'sch' tags
    const schTags = tags.filter(tag => tag[0] === 'sch');
    schTags.forEach(tag => {
        const [, dayKey, start, end] = tag;
        if (availability[dayKey]) {
            availability[dayKey] = {
                enabled: true,
                start: start || '09:00',
                end: end || '17:00'
            };
        }
    });
    
    return availability;
}

// Updated RSVP processing function with proper chronological handling
function processRSVPEvent(event) {
    try {
        console.log('🔍 Processing RSVP event:', event);
        
        // Prevent duplicate processing
        if (processedEvents.has(event.id)) {
            console.log(`⚠️ Event ${event.id} already processed, skipping`);
            return;
        }
        processedEvents.add(event.id);
        
        const dTag = event.tags.find(tag => tag[0] === 'd')?.[1];
        const statusTag = event.tags.find(tag => tag[0] === 'status')?.[1];
        const aTag = event.tags.find(tag => tag[0] === 'a')?.[1];
        
        if (!dTag) {
            console.log('❌ Invalid RSVP - missing d tag');
            return;
        }
        
        const rsvp = {
            id: event.id,
            dTag,
            status: statusTag || 'unknown',
            relatedRequest: aTag,
            fromPubkey: event.pubkey,
            createdAt: event.created_at,
            event
        };
        
        // Handle RSVPs for the same booking request
        if (aTag) {
            const requestId = aTag.split(':')[2]; // Extract d tag from a tag
            
            // Find all existing RSVPs for this booking request
            const relatedRSVPs = rsvpEvents.filter(existingRSVP => 
                existingRSVP.relatedRequest === aTag ||
                (existingRSVP.event && existingRSVP.event.tags.some(tag => 
                    tag[0] === 'a' && tag[1] === aTag
                ))
            );
            
            // Add the new RSVP to the list for comparison
            relatedRSVPs.push(rsvp);
            
            // Sort by creation time (newest first) and keep only the most recent
            relatedRSVPs.sort((a, b) => b.createdAt - a.createdAt);
            const mostRecentRSVP = relatedRSVPs[0];
            
            console.log(`📨 Found ${relatedRSVPs.length} RSVPs for booking ${requestId}, using most recent:`, mostRecentRSVP);
            
            // Remove all old RSVPs for this booking request
            rsvpEvents = rsvpEvents.filter(existingRSVP => 
                !(existingRSVP.relatedRequest === aTag ||
                  (existingRSVP.event && existingRSVP.event.tags.some(tag => 
                      tag[0] === 'a' && tag[1] === aTag
                  )))
            );
            
            // Add only the most recent RSVP
            rsvpEvents.push(mostRecentRSVP);
            
            // Update the corresponding booking request status with the most recent RSVP
            const request = bookingRequests.find(req => req.dTag === requestId);
            if (request) {
                const oldStatus = request.status;
                request.status = mostRecentRSVP.status;
                console.log(`📅 Updated booking request ${requestId} status: ${oldStatus} → ${mostRecentRSVP.status} (timestamp: ${mostRecentRSVP.createdAt})`);
            } else {
                console.log(`⚠️ Could not find booking request ${requestId} to update status`);
            }
        } else {
            // Handle RSVPs without aTag (fallback to dTag matching)
            const existingIndex = rsvpEvents.findIndex(existingRSVP => existingRSVP.dTag === dTag);
            if (existingIndex >= 0) {
                // Compare timestamps and keep the newer one
                if (rsvpEvents[existingIndex].createdAt < rsvp.createdAt) {
                    console.log(`📨 Replacing older RSVP ${dTag} with newer one`);
                    rsvpEvents[existingIndex] = rsvp;
                } else {
                    console.log(`📨 Keeping existing newer RSVP ${dTag}, ignoring older one`);
                }
            } else {
                console.log(`📨 Adding new RSVP to rsvpEvents array: ${dTag}`);
                rsvpEvents.push(rsvp);
            }
        }
        
        console.log('✅ Processed RSVP with chronological handling:', rsvp);
        
        // Refresh booking display if we're on the bookings page
        if (currentPage === 'bookings') {
            renderBookings();
        }
        
        // Update calendar view if we're on the calendar page
        if (currentPage === 'calendar') {
            updateCalendarView();
        }
        
    } catch (error) {
        console.error('❌ Error processing RSVP event:', error);
    }
}

// Updated function to get the most recent RSVP status for a booking request
function getMostRecentRSVPStatus(request) {
    // Find all RSVPs related to this booking request
    const relatedRSVPs = rsvpEvents.filter(rsvp => 
        rsvp.relatedRequest === `31923:${request.bookerPubkey}:${request.dTag}` ||
        (rsvp.event && rsvp.event.tags.some(tag => tag[0] === 'e' && tag[1] === request.id))
    );
    
    if (relatedRSVPs.length === 0) {
        return null;
    }
    
    // Sort by creation time and return the most recent status
    relatedRSVPs.sort((a, b) => b.createdAt - a.createdAt);
    return relatedRSVPs[0].status;
}

// Add function to clear processed events cache when needed
function clearProcessedEventsCache() {
    processedEvents.clear();
    console.log('Cleared processed events cache');
}

// Call this when reconnecting to relays or refreshing data
function resetEventProcessing() {
    clearProcessedEventsCache();
    rsvpEvents = [];
    bookingRequests = [];
    ownerEvents = [];
    dateBasedEvents = [];
    console.log('Reset all event processing state');
}

// Load availability templates from relays
async function loadAvailabilityTemplates() {
    availabilityTemplates = [];
    
    // Query relays for kind 31926 events from this user that reference current calendar
    const filter = {
        kinds: [31926],
        authors: [userPubkey],
        '#a': [`31924:${userPubkey}:${currentCalendarId}`]
    };
    
    const subscriptionId = 'availability-' + Date.now();
    const reqMessage = ['REQ', subscriptionId, filter];
    
    console.log('Loading availability templates for calendar:', currentCalendarId, 'with filter:', filter);
    
    // Send to all connected relays
    relayConnections.forEach((ws, relayUrl) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(reqMessage));
        }
    });
    
    // Wait a bit for responses, then render
    setTimeout(() => {
        console.log('Loaded availability templates:', availabilityTemplates.length);
        renderAvailabilityTemplates();
    }, 2000);
}

function renderAvailabilityTemplates() {
    const container = document.getElementById('eventSlotsContent');
    
    if (availabilityTemplates.length === 0) {
        const currentCalendar = calendars.find(cal => cal.id === currentCalendarId);
        const calendarName = currentCalendar ? currentCalendar.title : 'this calendar';
        
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📅</div>
                <h3>No availability templates yet</h3>
                <p>Create your first availability template for ${calendarName} to start accepting bookings.</p>
                <button class="btn-primary" onclick="openCreateModal()" style="margin-top: 1rem;">
                    <span class="icon-plus"></span>
                    Create Template
                </button>
            </div>
        `;
        return;
    }
    
    const cardsHTML = availabilityTemplates.map(template => {
        const enabledDays = Object.entries(template.availability)
            .filter(([day, config]) => config.enabled)
            .map(([day]) => day)
            .join(', ');
        
        const bookingLink = generateBookingLink(template);
        
        return `
            <div class="event-card">
                <div class="event-card-header">
                    <div style="flex: 1;">
                        <h3>${template.title}</h3>
                        <p>${template.description}</p>
                        <div class="event-meta">
                            <span><span class="icon-clock"></span> ${formatDuration(template.duration)}</span>
                            <span><span class="icon-calendar"></span> Available: ${enabledDays}</span>
                            <span>💰 ${template.zapAmount} sats</span>
                            ${template.bufferBefore > 0 || template.bufferAfter > 0 ? `<span>🔄 ${template.bufferBefore}m/${template.bufferAfter}m buffer</span>` : ''}
                            ${template.minNotice > 0 ? `<span>⏰ ${template.minNotice}m notice</span>` : ''}
                            <span>📅 ${template.maxAdvance === 0 ? 'Unlimited advance' : template.maxAdvance + ' days advance'}</span>
                        </div>
                        <div class="link-preview" style="margin-top: 0.5rem;">
                            <strong>Booking Link:</strong><br>
                            <span style="font-size: 0.75rem; word-break: break-all;">${bookingLink}</span>
                        </div>
                    </div>
                    <div class="event-actions">
                        <button class="icon-btn" onclick="editAvailabilityTemplate('${template.id}')" title="Edit">
                            <span class="icon-edit"></span>
                        </button>
                        <button class="icon-btn delete-btn" onclick="deleteAvailabilityTemplate('${template.id}')" title="Delete Template">
                            ✖
                        </button>
                        <button class="icon-btn" onclick="copyBookingLink('${template.id}')" title="Copy Booking Link">
                            <span class="icon-globe"></span>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = `
        <div class="event-cards">
            ${cardsHTML}
        </div>
    `;
}

function generateBookingLink(template) {
    // Create the naddr in the correct format
    const naddr = `naddr1${userPubkey.slice(0, 8)}31926${template.id}`;
    
    // Return the new booking URL format
    return `${window.location.origin}/booking.html?naddr=nostr:${naddr}`;
}

// Page navigation
function showPage(pageId) {
    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    event.target.classList.add('active');
    
    // Hide all pages
    document.querySelectorAll('.page').forEach(page => {
        page.classList.add('hidden');
    });
    
    // Show selected page
    document.getElementById(pageId + '-page').classList.remove('hidden');
    currentPage = pageId;
    
    // Load data for the specific page
    if (pageId === 'bookings') {
        loadBookingRequests();
    } else if (pageId === 'calendar') {
        loadCalendarEvents();
    }
}

// Modal functionality
function openCreateModal() {
    currentEditingTemplate = null;
    modalStep = 1;
    document.getElementById('modalTitle').textContent = 'Create availability template';
    document.getElementById('saveText').textContent = 'Create Template';
    resetModal();
    setupAvailabilityEditor();
    document.getElementById('eventModal').classList.remove('hidden');
}

function editAvailabilityTemplate(templateId) {
    const template = availabilityTemplates.find(t => t.id === templateId);
    if (!template) return;
    
    currentEditingTemplate = template;
    modalStep = 1;
    document.getElementById('modalTitle').textContent = 'Edit availability template';
    document.getElementById('saveText').textContent = 'Save Changes';
    
    // Populate form with existing data
    document.getElementById('eventTitle').value = template.title;
    document.getElementById('eventDescription').value = template.description;
    document.getElementById('eventDuration').value = template.duration;
    document.getElementById('eventInterval').value = template.interval || template.duration;
    document.getElementById('eventLocation').value = template.location || 'Jitsi Video';
    document.getElementById('eventZapAmount').value = template.zapAmount || 0;
    document.getElementById('eventBufferBefore').value = template.bufferBefore || 0;
    document.getElementById('eventBufferAfter').value = template.bufferAfter || 0;
    document.getElementById('eventMinNotice').value = template.minNotice || 0;
    document.getElementById('eventMaxAdvance').value = template.maxAdvance || 0;
    document.getElementById('eventMaxAdvanceBusiness').checked = template.maxAdvanceBusiness || false;
    
    resetModal();
    setupAvailabilityEditor(template.availability);
    document.getElementById('eventModal').classList.remove('hidden');
}

function copyBookingLink(templateId) {
    const template = availabilityTemplates.find(t => t.id === templateId);
    if (!template) {
        alert('Template not found');
        return;
    }
    
    const bookingLink = generateBookingLink(template);
    
    // Use the modern clipboard API with better error handling
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(bookingLink).then(() => {
            // Show success message
            const button = event.target.closest('.icon-btn');
            const originalHTML = button.innerHTML;
            button.innerHTML = '<span class="copy-success">Copied!</span>';
            setTimeout(() => {
                button.innerHTML = originalHTML;
            }, 2000);
        }).catch((error) => {
            console.error('Clipboard API failed:', error);
            // Fallback to the legacy method
            fallbackCopyTextToClipboard(bookingLink);
        });
    } else {
        // Fallback for older browsers
        fallbackCopyTextToClipboard(bookingLink);
    }
}

async function deleteAvailabilityTemplate(templateId) {
    const template = availabilityTemplates.find(t => t.id === templateId);
    if (!template) {
        alert('Template not found');
        return;
    }
    
    // Confirm deletion
    if (!confirm(`Are you sure you want to delete "${template.title}"? This action cannot be undone and will remove the template and its booking link.`)) {
        return;
    }
    
    try {
        // Create a deletion event (kind 5) to delete the availability template
        const deletionEvent = {
            kind: 5,
            pubkey: userPubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', template.event.id], // Reference to the event being deleted
                ['a', `31926:${userPubkey}:${templateId}`], // Reference to the replaceable event
                ['k', '31926'] // Kind of event being deleted
            ],
            content: `Deleted availability template: ${template.title}`
        };
        
        // Sign the deletion event
        const signedDeletionEvent = await window.nostr.signEvent(deletionEvent);
        console.log('Signed deletion event:', signedDeletionEvent);
        
        // Publish to all connected relays
        const publishPromises = [];
        relayConnections.forEach((ws, relayUrl) => {
            if (ws.readyState === WebSocket.OPEN) {
                publishPromises.push(new Promise((resolve) => {
                    const eventMessage = ['EVENT', signedDeletionEvent];
                    ws.send(JSON.stringify(eventMessage));
                    console.log(`Published deletion event to ${relayUrl}`);
                    setTimeout(resolve, 1000);
                }));
            }
        });
        
        await Promise.allSettled(publishPromises);
        
        // Remove from local state immediately
        const templateIndex = availabilityTemplates.findIndex(t => t.id === templateId);
        if (templateIndex >= 0) {
            availabilityTemplates.splice(templateIndex, 1);
        }
        
        // Re-render the templates list
        renderAvailabilityTemplates();
        
        alert(`"${template.title}" has been deleted successfully.`);
    } catch (error) {
        console.error('Error deleting availability template:', error);
        alert('Failed to delete template. Please try again.');
    }
}

function closeEventModal() {
    document.getElementById('eventModal').classList.add('hidden');
    currentEditingTemplate = null;
    modalStep = 1;
    document.getElementById('eventForm').reset();
}

function resetModal() {
    // Reset steps
    document.querySelectorAll('.modal-step').forEach((step, index) => {
        step.classList.toggle('active', index === 0);
    });
    document.querySelectorAll('.step-dot').forEach((dot, index) => {
        dot.classList.toggle('active', index === 0);
    });
    modalStep = 1;
}

function nextStep() {
    if (modalStep === 1) {
        // Validate step 1
        const title = document.getElementById('eventTitle').value.trim();
        if (!title) {
            alert('Please enter a title for your availability template.');
            return;
        }
        
        modalStep = 2;
        document.getElementById('step1').classList.remove('active');
        document.getElementById('step2').classList.add('active');
        document.getElementById('step1Dot').classList.remove('active');
        document.getElementById('step2Dot').classList.add('active');
    }
}

function prevStep() {
    if (modalStep === 2) {
        modalStep = 1;
        document.getElementById('step2').classList.remove('active');
        document.getElementById('step1').classList.add('active');
        document.getElementById('step2Dot').classList.remove('active');
        document.getElementById('step1Dot').classList.add('active');
    }
}

async function saveAvailabilityTemplate() {
    const saveBtn = document.getElementById('saveBtn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<div class="spinner"></div>Saving...';
    
    try {
        const title = document.getElementById('eventTitle').value.trim();
        const description = document.getElementById('eventDescription').value.trim();
        const duration = parseInt(document.getElementById('eventDuration').value);
        const interval = parseInt(document.getElementById('eventInterval').value) || duration;
        const location = document.getElementById('eventLocation').value;
        const zapAmount = parseInt(document.getElementById('eventZapAmount').value) || 0;
        const bufferBefore = parseInt(document.getElementById('eventBufferBefore').value) || 0;
        const bufferAfter = parseInt(document.getElementById('eventBufferAfter').value) || 0;
        const minNotice = parseInt(document.getElementById('eventMinNotice').value) || 0;
        const maxAdvance = parseInt(document.getElementById('eventMaxAdvance').value); // Allow 0
        const maxAdvanceBusiness = document.getElementById('eventMaxAdvanceBusiness').checked;
        const availability = collectAvailabilityData();
        
        const templateId = currentEditingTemplate ? currentEditingTemplate.id : generateTemplateId();
        
        const templateData = {
            id: templateId,
            title,
            description,
            duration,
            interval,
            location,
            zapAmount,
            bufferBefore,
            bufferAfter,
            minNotice,
            maxAdvance, // Can be 0 for unlimited
            maxAdvanceBusiness,
            availability
        };
        
        await publishAvailabilityTemplate(templateData);
        
        // Update local state
        if (currentEditingTemplate) {
            const index = availabilityTemplates.findIndex(t => t.id === templateId);
            if (index >= 0) {
                availabilityTemplates[index] = { ...availabilityTemplates[index], ...templateData };
            }
        } else {
            availabilityTemplates.push(templateData);
        }
        
        renderAvailabilityTemplates();
        closeEventModal();
        
    } catch (error) {
        console.error('Error saving availability template:', error);
        alert('Error saving template. Please try again.');
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<span id="saveText">Save Changes</span>';
    }
}

// Updated to use NIP-52 compliant tags
async function publishAvailabilityTemplate(templateData) {
    const event = {
        kind: 31926,
        pubkey: userPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['d', templateData.id],
            ['a', `31924:${userPubkey}:${currentCalendarId}`], // Link to current calendar
            ['title', templateData.title],
            ['tzid', Intl.DateTimeFormat().resolvedOptions().timeZone],
            ['duration', `PT${templateData.duration}M`],
            ['interval', `PT${templateData.interval}M`],
            ['amount_sats', templateData.zapAmount.toString()],
            ['buffer_before', `PT${templateData.bufferBefore}M`],
            ['buffer_after', `PT${templateData.bufferAfter}M`],
            ['min_notice', `PT${templateData.minNotice}M`],
            ['max_advance', templateData.maxAdvance === 0 ? 'P0D' : `P${templateData.maxAdvance}D`],
            ['max_advance_business', templateData.maxAdvanceBusiness.toString()],
            ...generateAvailabilityTags(templateData.availability)
        ],
        content: templateData.description
    };
    
    console.log('Availability template event before signing:', JSON.stringify(event, null, 2));
    
    // Sign the event
    let signedEvent;
    try {
        signedEvent = await window.nostr.signEvent(event);
        console.log('Signed event:', JSON.stringify(signedEvent, null, 2));
    } catch (error) {
        console.error('Failed to sign event:', error);
        throw error;
    }
    
    // Publish to all connected relays
    const promises = [];
    relayConnections.forEach((ws, relayUrl) => {
        if (ws.readyState === WebSocket.OPEN) {
            promises.push(new Promise((resolve, reject) => {
                const eventMessage = ['EVENT', signedEvent];
                console.log(`Publishing to ${relayUrl}:`, JSON.stringify(eventMessage));
                
                // Listen for OK response
                const originalOnMessage = ws.onmessage;
                const timeout = setTimeout(() => {
                    console.log(`Timeout waiting for OK from ${relayUrl}`);
                    ws.onmessage = originalOnMessage;
                    resolve('timeout');
                }, 5000);
                
                ws.onmessage = (event) => {
                    const message = JSON.parse(event.data);
                    if (message[0] === 'OK' && message[1] === signedEvent.id) {
                        clearTimeout(timeout);
                        ws.onmessage = originalOnMessage;
                        console.log(`OK response from ${relayUrl}:`, message);
                        resolve(message[2] ? 'success' : message[3]); // true = success, false = failure with reason
                    } else {
                        // Pass other messages to original handler
                        if (originalOnMessage) originalOnMessage(event);
                    }
                };
                
                try {
                    ws.send(JSON.stringify(eventMessage));
                } catch (sendError) {
                    clearTimeout(timeout);
                    ws.onmessage = originalOnMessage;
                    console.error(`Failed to send to ${relayUrl}:`, sendError);
                    reject(sendError);
                }
            }));
        } else {
            console.log(`Skipping ${relayUrl} - connection not open`);
        }
    });
    
    const results = await Promise.allSettled(promises);
    console.log('Publish results:', results);
    
    return signedEvent;
}

// Updated to generate 'sch' tags instead of 'w' tags for NIP-52 compliance
function generateAvailabilityTags(availability) {
    return Object.entries(availability)
        .filter(([day, slot]) => slot.enabled)
        .map(([dayKey, slot]) => ['sch', dayKey, slot.start, slot.end]);
}

// Load booking requests from relays
async function loadBookingRequests() {
    // Reset all event processing state to prevent conflicts
    resetEventProcessing();
    
    // Query for booking requests directed to us (31923 from bookers)
    const requestFilter = {
        kinds: [31923],
        '#p': [userPubkey]
    };
    
    // Query for our own events (31923 from us)
    const ownerEventsFilter = {
        kinds: [31923],
        authors: [userPubkey]
    };
    
    // Query for date-based events (31922)
    const dateBasedFilter = {
        kinds: [31922],
        authors: [userPubkey],
        since: Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60) // Last 90 days
    };
    
    // Query for RSVP events (31925)
    const rsvpIncomingFilter = {
        kinds: [31925],
        '#p': [userPubkey]
    };
    
    const rsvpOutgoingFilter = {
        kinds: [31925],
        authors: [userPubkey]
    };
    
    const subscriptions = [
        ['requests-' + Date.now(), requestFilter],
        ['owner-events-' + Date.now(), ownerEventsFilter],
        ['date-based-' + Date.now(), dateBasedFilter],
        ['rsvp-in-' + Date.now(), rsvpIncomingFilter],
        ['rsvp-out-' + Date.now(), rsvpOutgoingFilter]
    ];
    
    console.log('Loading booking data with filters:', {
        requests: requestFilter,
        ownerEvents: ownerEventsFilter,
        dateBased: dateBasedFilter,
        rsvpIncoming: rsvpIncomingFilter,
        rsvpOutgoing: rsvpOutgoingFilter
    });
    
    // Send to all connected relays
    relayConnections.forEach((ws, relayUrl) => {
        if (ws.readyState === WebSocket.OPEN) {
            console.log(`Sending queries to ${relayUrl}`);
            subscriptions.forEach(([subId, filter]) => {
                const reqMessage = ['REQ', subId, filter];
                ws.send(JSON.stringify(reqMessage));
            });
        }
    });
    
    // Wait a bit for responses
    setTimeout(() => {
        console.log('=== BOOKING DATA SUMMARY ===');
        console.log('Loaded booking requests:', bookingRequests.length);
        console.log('Loaded owner events:', ownerEvents.length);
        console.log('Loaded date-based events:', dateBasedEvents.length);
        console.log('Loaded RSVP events:', rsvpEvents.length);
        console.log('===========================');
        if (currentPage === 'bookings') {
            renderBookings();
        }
    }, 3000);
}

// Fixed booking response - REMOVED redundant 31923 creation
async function respondToBooking(requestId, status) {
    try {
        // 1️⃣ Look up the original booking request
        const request = bookingRequests.find(req => req.id === requestId);
        if (!request) {
            alert('Booking request not found');
            return;
        }
        console.log(`${status === 'accepted' ? 'Accepting' : 'Declining'} request:`, request);
        
        // 2️⃣ Build & sign ONLY the 31925 RSVP (no redundant 31923!)
        const rsvpId = `rsvp-${Date.now().toString(36)}`;
        const rsvpEvent = {
            kind: 31925,
            pubkey: userPubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', rsvpId],
                ['a', `31923:${request.bookerPubkey}:${request.dTag}`], // points to the request
                ['e', request.id],                                      // points to the event ID
                ['p', request.bookerPubkey],                           // tag the booker
                ['status', status],
                ['fb', status === 'accepted' ? 'busy' : 'free']
            ],
            content: status === 'accepted'
                ? 'Confirmed! Looking forward to our meeting.'
                : 'Sorry, this time is not available.'
        };
        const signedRSVP = await window.nostr.signEvent(rsvpEvent);
        console.log('Signed RSVP event:', signedRSVP);
        
        // 3️⃣ Publish only the RSVP
        relayConnections.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(['EVENT', signedRSVP]));
            }
        });
        
        // 4️⃣ Update local state
        request.status = status;
        
        // Add RSVP to local state
        rsvpEvents.push({
            id: signedRSVP.id,
            dTag: rsvpId,
            status: status,
            relatedRequest: `31923:${request.bookerPubkey}:${request.dTag}`,
            fromPubkey: userPubkey,
            createdAt: Math.floor(Date.now() / 1000),
            event: signedRSVP
        });
        
        renderBookings();
        alert(`Booking ${status} successfully!`);
        
    } catch (error) {
        console.error('Error responding to booking:', error);
        alert('Failed to respond to booking. Please try again.');
    }
}

// Validate booking request against its availability template
function validateBookingRequest(request) {
    try {
        // Extract template reference from the booking request
        const templateRef = request.templateRef; // This is the 'a' tag value
        if (!templateRef) {
            console.log(`❌ Request ${request.id}: No template reference`);
            return false;
        }
        
        // Parse the template reference: "31926:pubkey:templateId" -> we want the templateId
        const templateId = templateRef.split(':')[2];
        if (!templateId) {
            console.log(`❌ Request ${request.id}: Invalid template reference format`);
            return false;
        }
        
        // Find the availability template
        const template = availabilityTemplates.find(t => t.id === templateId);
        if (!template) {
            console.log(`❌ Request ${request.id}: Template ${templateId} not found`);
            return false;
        }
        
        // 1️⃣ Check duration matches template
        const requestDuration = Math.round((request.endTime - request.startTime) / (1000 * 60)); // minutes
        if (requestDuration !== template.duration) {
            console.log(`❌ Request ${request.id}: Duration mismatch. Request: ${requestDuration}min, Template: ${template.duration}min`);
            return false;
        }
        
        // 2️⃣ Check if the requested day is enabled in template
        const requestDate = new Date(request.startTime);
        const requestDayKey = dayKeys[requestDate.getDay()];
        
        if (!template.availability[requestDayKey] || !template.availability[requestDayKey].enabled) {
            console.log(`❌ Request ${request.id}: Day ${requestDayKey} not enabled in template`);
            return false;
        }
        
        // 3️⃣ Check if request time falls within template availability window
        const requestStartTime = `${requestDate.getHours().toString().padStart(2, '0')}:${requestDate.getMinutes().toString().padStart(2, '0')}`;
        const requestEndTime = new Date(request.endTime);
        const requestEndTimeStr = `${requestEndTime.getHours().toString().padStart(2, '0')}:${requestEndTime.getMinutes().toString().padStart(2, '0')}`;
        
        const templateStart = template.availability[requestDayKey].start;
        const templateEnd = template.availability[requestDayKey].end;
        
        // Convert times to minutes for easier comparison
        const timeToMinutes = (timeStr) => {
            const [hours, minutes] = timeStr.split(':').map(Number);
            return hours * 60 + minutes;
        };
        
        const reqStartMinutes = timeToMinutes(requestStartTime);
        const reqEndMinutes = timeToMinutes(requestEndTimeStr);
        const templateStartMinutes = timeToMinutes(templateStart);
        const templateEndMinutes = timeToMinutes(templateEnd);
        
        if (reqStartMinutes < templateStartMinutes || reqEndMinutes > templateEndMinutes) {
            console.log(`❌ Request ${request.id}: Time ${requestStartTime}-${requestEndTimeStr} outside availability window ${templateStart}-${templateEnd}`);
            return false;
        }
        
        // 4️⃣ All validations passed
        console.log(`✅ Request ${request.id}: Valid booking request`);
        return true;
        
    } catch (error) {
        console.error(`❌ Error validating request ${request.id}:`, error);
        return false;
    }
}

// Updated renderBookings function to use the most recent RSVP status
function renderBookings() {
    const content = document.getElementById('bookingContent');
    
    console.log('=== RENDERING BOOKINGS ===');
    console.log('Current tab:', currentBookingTab);
    
    // Filter based on current tab
    let filteredItems = [];
    const now = Date.now();
    
    switch (currentBookingTab) {
        case 'upcoming':
            // Show accepted bookings that are in the future
            filteredItems = bookingRequests.filter(req => {
                const mostRecentStatus = getMostRecentRSVPStatus(req);
                const isAccepted = mostRecentStatus === 'accepted' || req.status === 'accepted';
                return isAccepted && req.startTime > now;
            });
            break;
        case 'unconfirmed':
            // Show pending booking requests that are valid and don't have RSVPs
            filteredItems = bookingRequests.filter(req => {
                const mostRecentStatus = getMostRecentRSVPStatus(req);
                if (mostRecentStatus) return false; // Has an RSVP, so not unconfirmed
                return req.status === 'pending' && validateBookingRequest(req);
            });
            break;
        case 'past':
            // Show accepted bookings that are in the past
            filteredItems = bookingRequests.filter(req => {
                const mostRecentStatus = getMostRecentRSVPStatus(req);
                const isAccepted = mostRecentStatus === 'accepted' || req.status === 'accepted';
                return isAccepted && req.endTime <= now;
            });
            break;
        case 'canceled':
            // Show declined requests (including canceled ones)
            filteredItems = bookingRequests.filter(req => {
                const mostRecentStatus = getMostRecentRSVPStatus(req);
                return mostRecentStatus === 'declined' || req.status === 'declined';
            });
            break;
    }
    
    if (filteredItems.length === 0) {
        const messages = {
            upcoming: 'You have no upcoming meetings. As soon as you approve a booking it will show up here.',
            unconfirmed: 'You have no unconfirmed booking requests.',
            past: 'You have no past meetings.',
            canceled: 'You have no canceled bookings.'
        };
        
        content.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📅</div>
                <h3>No ${currentBookingTab} ${currentBookingTab === 'upcoming' || currentBookingTab === 'past' ? 'meetings' : 'bookings'}</h3>
                <p>${messages[currentBookingTab]}</p>
            </div>
        `;
        return;
    }
    
    // Render booking request cards
    const cards = filteredItems.map(request => renderBookingRequestCard(request)).join('');
    content.innerHTML = `
        <div class="event-cards">
            ${cards}
        </div>
    `;
}

// Updated renderBookingRequestCard to show the correct status based on most recent RSVP
function renderBookingRequestCard(request) {
    const startTime = new Date(request.startTime);
    const endTime = new Date(request.endTime);
    
    const dateStr = startTime.toLocaleDateString('en-US', { 
        month: 'short',
        day: 'numeric'
    });
    
    const startStr = startTime.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
    });
    const endStr = endTime.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
    });
    
    const timeDisplay = `${dateStr} ${startStr} - ${endStr}`;
    
    // Use proper npub for the link and truncated version for display
    const fullNpub = hexToNpub(request.bookerPubkey);
    const displayNpub = truncateNpub(fullNpub);
    
    // Get the most recent RSVP status
    const mostRecentStatus = getMostRecentRSVPStatus(request);
    const effectiveStatus = mostRecentStatus || request.status;
    
    // Determine status color and display
    let statusColor, statusText, actionButtons = '';
    
    // Check if this is an upcoming confirmed event that can be canceled
    const isUpcomingConfirmed = (effectiveStatus === 'accepted') && 
                               (currentBookingTab === 'upcoming') && 
                               (request.startTime > Date.now());
    
    switch (effectiveStatus) {
        case 'pending':
            statusColor = '#d97706';
            statusText = 'PENDING';
            actionButtons = `
                <div class="action-buttons">
                    <div class="button-row">
                        <button class="btn-primary" onclick="respondToBooking('${request.id}', 'accepted')" 
                                style="background-color: #059669; margin-right: 0.5rem;">
                            Accept
                        </button>
                        <button class="btn-primary" onclick="respondToBooking('${request.id}', 'declined')" 
                                style="background-color: #dc2626;">
                            Decline
                        </button>
                    </div>
                </div>
            `;
            break;
        case 'accepted':
            statusColor = '#059669';
            statusText = 'CONFIRMED';
            if (isUpcomingConfirmed) {
                actionButtons = `
                    <div class="action-buttons">
                        <button class="btn-cancel" onclick="cancelBooking('${request.id}', 'request')" title="Cancel Meeting">
                            <span class="icon-cancel"></span>
                            Cancel
                        </button>
                    </div>
                `;
            }
            break;
        case 'declined':
            statusColor = '#dc2626';
            statusText = 'DECLINED';
            break;
        default:
            statusColor = '#6b7280';
            statusText = effectiveStatus.toUpperCase();
    }
    
    // Add debug info if there are conflicting RSVPs
    const relatedRSVPs = rsvpEvents.filter(rsvp => 
        rsvp.relatedRequest === `31923:${request.bookerPubkey}:${request.dTag}` ||
        (rsvp.event && rsvp.event.tags.some(tag => tag[0] === 'e' && tag[1] === request.id))
    );
    
    let debugInfo = '';
    if (relatedRSVPs.length > 1) {
        const sortedRSVPs = [...relatedRSVPs].sort((a, b) => b.createdAt - a.createdAt);
        debugInfo = `
            <div style="margin-top: 0.5rem; padding: 0.5rem; background-color: #f3f4f6; border-radius: 0.25rem; font-size: 0.75rem;">
                <strong>Debug:</strong> ${relatedRSVPs.length} RSVPs found. Using most recent: ${sortedRSVPs[0].status} (${new Date(sortedRSVPs[0].createdAt * 1000).toLocaleString()})
            </div>
        `;
    }
    
    return `
        <div class="event-card">
            <div class="event-card-header">
                <div style="flex: 1;">
                    <h3>${request.title}</h3>
                    <p>With: <a href="https://njump.me/${fullNpub}" target="_blank" rel="noopener noreferrer" style="color: #a855f7; text-decoration: underline;">${displayNpub}</a></p>
                    <div class="event-meta">
                        <span>
                            <span class="icon-clock"></span> 
                            ${timeDisplay}
                        </span>
                        <span>
                            📅 Requested: ${new Date(request.createdAt * 1000).toLocaleDateString('en-US', { 
                                month: 'short', 
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                                hour12: true
                            })}
                        </span>
                        <span style="padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; color: white; background-color: ${statusColor};">
                            ${statusText}
                        </span>
                    </div>
                    ${request.description ? `<p style="margin-top: 0.5rem; font-style: italic; color: #9ca3af;">"${request.description}"</p>` : ''}
                    ${debugInfo}
                </div>
                ${actionButtons}
            </div>
        </div>
    `;
}

// Cancel booking function (simplified)
async function cancelBooking(requestId, type) {
    try {
        const request = bookingRequests.find(req => req.id === requestId);
        if (!request) {
            alert('Booking request not found');
            return;
        }
        
        if (!confirm('Are you sure you want to cancel this meeting? This action cannot be undone.')) {
            return;
        }
        
        // Create declined RSVP to cancel
        const rsvpId = `cancel-${Date.now().toString(36)}`;
        const cancelRSVPEvent = {
            kind: 31925,
            pubkey: userPubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', rsvpId],
                ['a', `31923:${request.bookerPubkey}:${request.dTag}`],
                ['e', request.id],
                ['p', request.bookerPubkey],
                ['status', 'declined'],
                ['fb', 'free']
            ],
            content: 'Meeting has been canceled by the host.'
        };
        
        const signedCancelRSVP = await window.nostr.signEvent(cancelRSVPEvent);
        
        // Publish the cancellation
        relayConnections.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(['EVENT', signedCancelRSVP]));
            }
        });
        
        // Update local state
        request.status = 'declined';
        
        renderBookings();
        alert('Meeting canceled successfully!');
        
    } catch (error) {
        console.error('Error canceling booking:', error);
        alert('Failed to cancel booking. Please try again.');
    }
}

// Availability editor - Updated for ISO-8601 day mapping
function setupAvailabilityEditor(existingAvailability = null) {
    const container = document.getElementById('availabilityEditor');
    const availability = existingAvailability || getDefaultAvailability();
    
    container.innerHTML = '';
    
    dayNames.forEach((day, index) => {
        const dayKey = dayKeys[index];
        const dayData = availability[dayKey];
        
        const row = document.createElement('div');
        row.className = 'day-row';
        row.innerHTML = `
            <div class="day-toggle">
                <input type="checkbox" class="checkbox" 
                       ${dayData.enabled ? 'checked' : ''} 
                       onchange="toggleDay('${dayKey}', this.checked)">
                <span class="day-name ${dayData.enabled ? '' : 'disabled'}" id="dayName-${dayKey}">${day}</span>
            </div>
            ${dayData.enabled ? `
                <div class="time-inputs" id="timeInputs-${dayKey}">
                    <input type="time" class="time-input" value="${dayData.start}" id="start-${dayKey}">
                    <span style="color: #9ca3af;">-</span>
                    <input type="time" class="time-input" value="${dayData.end}" id="end-${dayKey}">
                </div>
            ` : `
                <span class="unavailable-text" id="timeInputs-${dayKey}">Unavailable</span>
            `}
        `;
        container.appendChild(row);
    });
}

function toggleDay(dayKey, enabled) {
    const nameElement = document.getElementById(`dayName-${dayKey}`);
    const timeInputs = document.getElementById(`timeInputs-${dayKey}`);
    
    if (enabled) {
        nameElement.classList.remove('disabled');
        timeInputs.innerHTML = `
            <input type="time" class="time-input" value="09:00" id="start-${dayKey}">
            <span style="color: #9ca3af;">-</span>
            <input type="time" class="time-input" value="17:00" id="end-${dayKey}">
        `;
    } else {
        nameElement.classList.add('disabled');
        timeInputs.innerHTML = '<span class="unavailable-text">Unavailable</span>';
    }
}

function collectAvailabilityData() {
    const availability = {};
    
    dayKeys.forEach(dayKey => {
        const checkbox = document.querySelector(`input[onchange*="${dayKey}"]`);
        const startInput = document.getElementById(`start-${dayKey}`);
        const endInput = document.getElementById(`end-${dayKey}`);
        
        availability[dayKey] = {
            enabled: checkbox.checked,
            start: startInput ? startInput.value : '09:00',
            end: endInput ? endInput.value : '17:00'
        };
    });
    
    return availability;
}

function getDefaultAvailability() {
    return {
        SU: { enabled: false, start: '09:00', end: '17:00' },
        MO: { enabled: true, start: '09:00', end: '17:00' },
        TU: { enabled: true, start: '09:00', end: '17:00' },
        WE: { enabled: true, start: '09:00', end: '17:00' },
        TH: { enabled: true, start: '09:00', end: '17:00' },
        FR: { enabled: true, start: '09:00', end: '17:00' },
        SA: { enabled: false, start: '09:00', end: '17:00' }
    };
}

// Convert hex pubkey to npub (proper bech32 encoding)
function hexToNpub(hexPubkey) {
    try {
        // Simple bech32 implementation for nostr pubkeys
        const bech32Charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
        
        function bech32Polymod(values) {
            const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
            let chk = 1;
            for (let p = 0; p < values.length; ++p) {
                const top = chk >> 25;
                chk = (chk & 0x1ffffff) << 5 ^ values[p];
                for (let i = 0; i < 5; ++i) {
                    chk ^= ((top >> i) & 1) ? GEN[i] : 0;
                }
            }
            return chk;
        }
        
        function bech32CreateChecksum(hrp, data) {
            const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
            const mod = bech32Polymod(values) ^ 1;
            const ret = [];
            for (let p = 0; p < 6; ++p) {
                ret[p] = (mod >> 5 * (5 - p)) & 31;
            }
            return ret;
        }
        
        function bech32HrpExpand(hrp) {
            const ret = [];
            let p;
            for (p = 0; p < hrp.length; ++p) {
                ret[p] = hrp.charCodeAt(p) >> 5;
            }
            ret[p++] = 0;
            for (let q = 0; q < hrp.length; ++q) {
                ret[p++] = hrp.charCodeAt(q) & 31;
            }
            return ret;
        }
        
        function convertBits(data, fromBits, toBits, pad) {
            let acc = 0;
            let bits = 0;
            const ret = [];
            const maxv = (1 << toBits) - 1;
            const maxAcc = (1 << (fromBits + toBits - 1)) - 1;
            for (let p = 0; p < data.length; ++p) {
                const value = data[p];
                if (value < 0 || (value >> fromBits) !== 0) {
                    return null;
                }
                acc = ((acc << fromBits) | value) & maxAcc;
                bits += fromBits;
                while (bits >= toBits) {
                    bits -= toBits;
                    ret.push((acc >> bits) & maxv);
                }
            }
            if (pad) {
                if (bits > 0) {
                    ret.push((acc << (toBits - bits)) & maxv);
                }
            } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
                return null;
            }
            return ret;
        }
        
        // Convert hex to bytes
        const bytes = [];
        for (let i = 0; i < hexPubkey.length; i += 2) {
            bytes.push(parseInt(hexPubkey.substr(i, 2), 16));
        }
        
        // Convert to 5-bit groups
        const data = convertBits(bytes, 8, 5, true);
        if (!data) throw new Error('Invalid data for base32 conversion');
        
        // Create checksum
        const checksum = bech32CreateChecksum('npub', data);
        const combined = data.concat(checksum);
        
        // Build final string
        let ret = 'npub1';
        for (let p = 0; p < combined.length; ++p) {
            ret += bech32Charset.charAt(combined[p]);
        }
        
        return ret;
    } catch (error) {
        console.error('Error converting hex to npub:', error);
        // Fallback to hex if conversion fails
        return hexPubkey;
    }
}

// Create a display version of npub (truncated for UI)
function truncateNpub(npub) {
    if (npub.startsWith('npub1')) {
        return `${npub.slice(0, 20)}...${npub.slice(-8)}`;
    }
    return npub;
}

// Utility functions
function formatDuration(minutes) {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function generateTemplateId() {
    return 'avail-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// Calendar functionality
async function loadCalendarEvents() {
    // Reset event processing state for calendar events
    ownerEvents = [];
    dateBasedEvents = [];
    
    // Clear any cached processed events for calendar-specific events
    // (but don't clear booking-related events if they're still being processed)
    const bookingEventIds = new Set([
        ...bookingRequests.map(req => req.id),
        ...rsvpEvents.map(rsvp => rsvp.id)
    ]);
    
    // Remove non-booking events from processed cache
    const filteredProcessedEvents = new Set();
    for (const eventId of processedEvents) {
        if (bookingEventIds.has(eventId)) {
            filteredProcessedEvents.add(eventId);
        }
    }
    processedEvents = filteredProcessedEvents;
    
    // Query for owner's time-based events (31923)
    const ownerEventsFilter = {
        kinds: [31923],
        authors: [userPubkey],
        since: Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60) // Last 90 days
    };
    
    // Query for date-based events (31922)
    const dateBasedFilter = {
        kinds: [31922],
        authors: [userPubkey],
        since: Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60) // Last 90 days
    };
    
    const subscriptions = [
        ['owner-events-' + Date.now(), ownerEventsFilter],
        ['date-based-' + Date.now(), dateBasedFilter]
    ];
    
    console.log('Loading calendar events with filters:', {
        ownerEvents: ownerEventsFilter,
        dateBased: dateBasedFilter
    });
    
    // Send to all connected relays
    relayConnections.forEach((ws, relayUrl) => {
        if (ws.readyState === WebSocket.OPEN) {
            console.log(`Sending calendar queries to ${relayUrl}`);
            subscriptions.forEach(([subId, filter]) => {
                const reqMessage = ['REQ', subId, filter];
                ws.send(JSON.stringify(reqMessage));
            });
        }
    });
    
    // Wait a bit for responses then render calendar
    setTimeout(() => {
        console.log('Loaded owner events:', ownerEvents.length);
        console.log('Loaded date-based events:', dateBasedEvents.length);
        updateCalendarView();
    }, 3000);
}

function updateCalendarView() {
    renderCalendar();
    aggregateAllCalendarEvents();
}

function renderCalendar() {
    const calendarGrid = document.getElementById('calendarGrid');
    const currentMonth = document.getElementById('currentMonth');
    
    // Update month header
    currentMonth.textContent = currentCalendarDate.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric'
    });
    
    // Get calendar data
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDate = new Date(firstDay);
    startDate.setDate(startDate.getDate() - firstDay.getDay());
    
    // Create calendar grid
    let calendarHTML = `
        <div class="calendar-header">
            <div class="calendar-header-day">Sun</div>
            <div class="calendar-header-day">Mon</div>
            <div class="calendar-header-day">Tue</div>
            <div class="calendar-header-day">Wed</div>
            <div class="calendar-header-day">Thu</div>
            <div class="calendar-header-day">Fri</div>
            <div class="calendar-header-day">Sat</div>
        </div>
        <div class="calendar-body">
    `;
    
    // Generate 6 weeks of days
    const currentDate = new Date(startDate);
    const today = new Date();
    
    for (let week = 0; week < 6; week++) {
        for (let day = 0; day < 7; day++) {
            const dayDate = new Date(currentDate);
            const isCurrentMonth = dayDate.getMonth() === month;
            const isToday = dayDate.toDateString() === today.toDateString();
            
            const dayEvents = getEventsForDay(dayDate);
            
            calendarHTML += `
                <div class="calendar-day ${!isCurrentMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}" 
                     data-date="${dayDate.toISOString().split('T')[0]}"
                     onclick="selectDay('${dayDate.toISOString().split('T')[0]}')">
                    <div class="day-number">${dayDate.getDate()}</div>
                    <div class="day-events">
                        ${dayEvents.map(event => `
                            <div class="calendar-event event-${event.type} ${activeEventTypes.has(event.type) ? '' : 'hidden'}"
                                 onclick="showEventDetails(event, '${event.id}'); event.stopPropagation();"
                                 title="${event.title}">
                                ${event.title}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            
            currentDate.setDate(currentDate.getDate() + 1);
        }
    }
    
    calendarHTML += '</div>';
    calendarGrid.innerHTML = calendarHTML;
}

// Updated getEventsForDay function with consistent validation
function getEventsForDay(date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);
    
    const events = [];
    
    // Add booking requests (unconfirmed) - only if no RSVP exists AND validation passes
    bookingRequests.forEach(request => {
        if (request.startTime >= dayStart.getTime() && request.startTime <= dayEnd.getTime()) {
            const mostRecentStatus = getMostRecentRSVPStatus(request);
            
            if (!mostRecentStatus) {
                // No RSVP exists - check if this is a valid booking request
                if (validateBookingRequest(request)) {
                    events.push({
                        id: request.id,
                        title: `📋 ${request.title}`,
                        type: 'booking-requests',
                        startTime: request.startTime,
                        endTime: request.endTime,
                        data: request
                    });
                } else {
                    // Invalid booking request - show as error/invalid type
                    events.push({
                        id: request.id,
                        title: `⚠️ ${request.title} (Invalid)`,
                        type: 'invalid-requests',
                        startTime: request.startTime,
                        endTime: request.endTime,
                        data: request
                    });
                }
            }
        }
    });
    
    // Add confirmed meetings (booking requests with accepted RSVPs)
    bookingRequests.forEach(request => {
        if (request.startTime >= dayStart.getTime() && request.startTime <= dayEnd.getTime()) {
            const mostRecentStatus = getMostRecentRSVPStatus(request);
            
            if (mostRecentStatus === 'accepted') {
                events.push({
                    id: request.id,
                    title: `✅ ${request.title}`,
                    type: 'confirmed-meetings',
                    startTime: request.startTime,
                    endTime: request.endTime,
                    data: request
                });
            }
        }
    });
    
    // Add owner events (31923 from owner)
    ownerEvents.forEach(event => {
        if (event.startTime >= dayStart.getTime() && event.startTime <= dayEnd.getTime()) {
            events.push({
                id: event.id,
                title: `⏰ ${event.title}`,
                type: 'owner-events',
                startTime: event.startTime,
                endTime: event.endTime,
                data: event
            });
        }
    });
    
    // Add all-day events (31922)
    dateBasedEvents.forEach(event => {
        const eventStart = new Date(event.startTime);
        const eventEnd = new Date(event.endTime);
        
        if (date >= eventStart && date <= eventEnd) {
            events.push({
                id: event.id,
                title: `📅 ${event.title}`,
                type: 'all-day-events',
                startTime: event.startTime,
                endTime: event.endTime,
                data: event
            });
        }
    });
    
    // Sort events by start time
    events.sort((a, b) => a.startTime - b.startTime);
    
    return events;
}

// Updated aggregateAllCalendarEvents to match the same logic
function aggregateAllCalendarEvents() {
    allCalendarEvents = [];
    
    // Add all event types with consistent validation
    bookingRequests.forEach(request => {
        const mostRecentStatus = getMostRecentRSVPStatus(request);
        
        if (!mostRecentStatus) {
            // No RSVP - check if valid
            if (validateBookingRequest(request)) {
                allCalendarEvents.push({
                    id: request.id,
                    title: `📋 ${request.title}`,
                    type: 'booking-requests',
                    startTime: request.startTime,
                    endTime: request.endTime,
                    data: request
                });
            } else {
                // Invalid booking request
                allCalendarEvents.push({
                    id: request.id,
                    title: `⚠️ ${request.title} (Invalid)`,
                    type: 'invalid-requests',
                    startTime: request.startTime,
                    endTime: request.endTime,
                    data: request
                });
            }
        } else if (mostRecentStatus === 'accepted') {
            allCalendarEvents.push({
                id: request.id,
                title: `✅ ${request.title}`,
                type: 'confirmed-meetings',
                startTime: request.startTime,
                endTime: request.endTime,
                data: request
            });
        }
    });
    
    ownerEvents.forEach(event => {
        allCalendarEvents.push({
            id: event.id,
            title: `⏰ ${event.title}`,
            type: 'owner-events',
            startTime: event.startTime,
            endTime: event.endTime,
            data: event
        });
    });
    
    dateBasedEvents.forEach(event => {
        allCalendarEvents.push({
            id: event.id,
            title: `📅 ${event.title}`,
            type: 'all-day-events',
            startTime: event.startTime,
            endTime: event.endTime,
            data: event
        });
    });
}

function changeMonth(direction) {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + direction);
    renderCalendar();
}

function toggleEventType(eventType) {
    const filterBtn = document.getElementById(`filter-${eventType}`);
    
    if (activeEventTypes.has(eventType)) {
        activeEventTypes.delete(eventType);
        filterBtn.classList.remove('active');
    } else {
        activeEventTypes.add(eventType);
        filterBtn.classList.add('active');
    }
    
    // Update calendar display
    document.querySelectorAll(`.event-${eventType}`).forEach((eventEl) => {
        if (activeEventTypes.has(eventType)) {
            eventEl.classList.remove('hidden');
        } else {
            eventEl.classList.add('hidden');
        }
    });
}

function selectDay(dateString) {
    const date = new Date(dateString);
    const events = getEventsForDay(date);
    
    if (events.length === 0) {
        return;
    }
    
    // Show day's events in detail panel
    showDayEvents(date, events);
}

function showDayEvents(date, events) {
    const panel = document.getElementById('eventDetails');
    const title = document.getElementById('eventDetailsTitle');
    const content = document.getElementById('eventDetailsContent');
    
    title.textContent = `Events for ${date.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    })}`;
    
    const eventsHTML = events
        .filter(event => activeEventTypes.has(event.type))
        .map(event => {
            const startTime = new Date(event.startTime);
            const endTime = new Date(event.endTime);
            
            // Determine if this event can be deleted
            let canDelete = false;
            let deleteAction = '';
            
            if (event.type === 'owner-events') {
                // Owner's 31923 events can be deleted
                canDelete = true;
                deleteAction = `deleteEvent('${event.id}', '31923')`;
            } else if (event.type === 'all-day-events') {
                // Date-based events (31922) can be deleted
                canDelete = true;
                deleteAction = `deleteEvent('${event.id}', '31922')`;
            }
            // booking-requests and confirmed-meetings can't be deleted (they're from others)
            
            return `
                <div class="event-detail-item">
                    ${canDelete ? `
                        <button class="icon-btn delete-btn" 
                                onclick="${deleteAction}; event.stopPropagation();" 
                                title="Delete Event">
                            ✖
                        </button>
                    ` : ''}
                    <h4 class="${canDelete ? 'with-delete' : ''}">
                        ${event.title}
                    </h4>
                    <p><strong>Time:</strong> ${startTime.toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                    })} - ${endTime.toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                    })}</p>
                    ${event.data.description ? `<p><strong>Description:</strong> ${event.data.description}</p>` : ''}
                    ${event.data.location ? `<p><strong>Location:</strong> ${event.data.location}</p>` : ''}
                    ${event.data.bookerPubkey ? `<p><strong>With:</strong> ${truncateNpub(hexToNpub(event.data.bookerPubkey))}</p>` : ''}
                </div>
            `;
        }).join('');
    
    content.innerHTML = eventsHTML || '<p>No events to display for the selected filters.</p>';
    panel.classList.remove('hidden');
}

function showEventDetails(event, eventId) {
    // Find the event in our data
    const calEvent = allCalendarEvents.find(e => e.id === eventId);
    if (!calEvent) return;
    
    showDayEvents(new Date(calEvent.startTime), [calEvent]);
}

function closeEventDetails() {
    document.getElementById('eventDetails').classList.add('hidden');
}

// Delete event function (NIP-09)
async function deleteEvent(eventId, eventKind) {
    let eventData = null;
    let eventTitle = '';
    
    // Find the event in appropriate array
    if (eventKind === '31923') {
        eventData = ownerEvents.find(evt => evt.id === eventId);
        eventTitle = eventData ? eventData.title : 'Event';
    } else if (eventKind === '31922') {
        eventData = dateBasedEvents.find(evt => evt.id === eventId);
        eventTitle = eventData ? eventData.title : 'All-Day Event';
    }
    
    if (!eventData) {
        alert('Event not found');
        return;
    }
    
    // Confirm deletion
    if (!confirm(`Are you sure you want to delete "${eventTitle}"? This action cannot be undone.`)) {
        return;
    }
    
    try {
        // Create a deletion event (kind 5) per NIP-09
        const deletionEvent = {
            kind: 5,
            pubkey: userPubkey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', eventData.event.id], // Reference to the event being deleted
                ['a', `${eventKind}:${userPubkey}:${eventData.dTag}`], // Reference to the replaceable event
                ['k', eventKind] // Kind of event being deleted
            ],
            content: `Deleted ${eventKind === '31922' ? 'all-day event' : 'event'}: ${eventTitle}`
        };
        
        // Sign the deletion event
        const signedDeletionEvent = await window.nostr.signEvent(deletionEvent);
        console.log('Signed deletion event:', signedDeletionEvent);
        
        // Publish to all connected relays
        const publishPromises = [];
        relayConnections.forEach((ws, relayUrl) => {
            if (ws.readyState === WebSocket.OPEN) {
                publishPromises.push(new Promise((resolve) => {
                    const eventMessage = ['EVENT', signedDeletionEvent];
                    ws.send(JSON.stringify(eventMessage));
                    console.log(`Published deletion event to ${relayUrl}`);
                    setTimeout(resolve, 1000);
                }));
            }
        });
        
        await Promise.allSettled(publishPromises);
        
        // Remove from local state immediately
        if (eventKind === '31923') {
            const eventIndex = ownerEvents.findIndex(evt => evt.id === eventId);
            if (eventIndex >= 0) {
                ownerEvents.splice(eventIndex, 1);
            }
        } else if (eventKind === '31922') {
            const eventIndex = dateBasedEvents.findIndex(evt => evt.id === eventId);
            if (eventIndex >= 0) {
                dateBasedEvents.splice(eventIndex, 1);
            }
        }
        
        // Update calendar view
        updateCalendarView();
        
        // Close the event details panel
        closeEventDetails();
        
        alert(`"${eventTitle}" has been deleted successfully.`);
        
    } catch (error) {
        console.error('Error deleting event:', error);
        alert('Failed to delete event. Please try again.');
    }
}

// Bookings functionality
function showBookingTab(tab) {
    // Update tab styling
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    currentBookingTab = tab;
    renderBookings();
}

// Debugging utility functions
function getInvalidBookingRequests() {
    return bookingRequests.filter(request => !validateBookingRequest(request));
}

function showInvalidBookingRequestsReport() {
    const invalidRequests = getInvalidBookingRequests();
    
    if (invalidRequests.length === 0) {
        console.log('✅ No invalid booking requests found');
        return;
    }
    
    console.log(`⚠️ Found ${invalidRequests.length} invalid booking requests:`);
    
    invalidRequests.forEach(request => {
        const templateRef = request.templateRef;
        const templateId = templateRef ? templateRef.split(':')[2] : 'none';
        const templateExists = templateId && availabilityTemplates.find(t => t.id === templateId);
        
        console.log(`📋 Request: ${request.title}`);
        console.log(`   ID: ${request.id}`);
        console.log(`   Template Ref: ${templateRef || 'missing'}`);
        console.log(`   Template ID: ${templateId || 'none'}`);
        console.log(`   Template Exists: ${templateExists ? 'Yes' : 'No'}`);
        console.log(`   Time: ${new Date(request.startTime).toLocaleString()}`);
        console.log(`   Booker: ${request.bookerPubkey}`);
        console.log('---');
    });
    
    return invalidRequests;
}

function analyzeTemplateReferences() {
    console.log('📊 Template Analysis:');
    console.log(`Available templates: ${availabilityTemplates.length}`);
    availabilityTemplates.forEach(template => {
        console.log(`  - ${template.id}: "${template.title}"`);
    });
    
    const referencedTemplates = new Set();
    bookingRequests.forEach(request => {
        if (request.templateRef) {
            const templateId = request.templateRef.split(':')[2];
            referencedTemplates.add(templateId);
        }
    });
    
    console.log(`\nReferenced templates: ${referencedTemplates.size}`);
    referencedTemplates.forEach(templateId => {
        const exists = availabilityTemplates.find(t => t.id === templateId);
        console.log(`  - ${templateId}: ${exists ? '✅ EXISTS' : '❌ MISSING'}`);
    });
}

// Fallback copy function
function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    
    // Avoid scrolling to bottom
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            // Show success message
            const button = event.target.closest('.icon-btn');
            const originalHTML = button.innerHTML;
            button.innerHTML = '<span class="copy-success">Copied!</span>';
            setTimeout(() => {
                button.innerHTML = originalHTML;
            }, 2000);
        } else {
            throw new Error('Copy command failed');
        }
    } catch (err) {
        console.error('Fallback copy failed:', err);
        // Final fallback - show the link in a prompt
        prompt('Copy this booking link:', text);
    }
    
    document.body.removeChild(textArea);
}

// Search functionality
document.addEventListener('DOMContentLoaded', function() {
    const searchInput = document.getElementById('eventSearch');
    if (searchInput) {
        searchInput.addEventListener('input', function(e) {
            const query = e.target.value.toLowerCase();
            const cards = document.querySelectorAll('.event-card');
            
            cards.forEach(card => {
                const title = card.querySelector('h3').textContent.toLowerCase();
                const description = card.querySelector('p').textContent.toLowerCase();
                
                if (title.includes(query) || description.includes(query)) {
                    card.style.display = 'block';
                } else {
                    card.style.display = 'none';
                }
            });
        });
    }
});