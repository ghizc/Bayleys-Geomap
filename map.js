// map.js
import { GOOGLE_MAP_ID, ADMIN_UUID, MAPBOX_TOKEN } from './config.js';
import { state } from './store.js';
import { supabase } from './api.js';
import { log, showDetail, getPremiseDisplayData } from './ui.js';

let clusterer = null;
let googleMarkers = [];

// Default map mode
if (!state.currentMapMode) state.currentMapMode = 'photo3d';

// ==========================================
// RIGHT-CLICK NAVIGATION OVERRIDE
// ==========================================
if (!window._rightClickInitialized) {
    window._rightClickInitialized = true;
    let isRightDragging = false;
    let sX, sY, sHeading, sTilt;

    // 1. Stop default right-click menu over maps
    document.addEventListener('contextmenu', e => {
        if (e.target.closest('#adminMap, #premisesMap, #loginMapBackground, gmp-map-3d')) {
            e.preventDefault();
        }
    });

    // 2. Capture initial camera angle on Right-Click
    document.addEventListener('mousedown', e => {
        if (e.button === 2 && state.mapInstance && e.target.closest('#adminMap, #premisesMap, #loginMapBackground, gmp-map-3d')) {
            isRightDragging = true;
            sX = e.clientX;
            sY = e.clientY;
            
            if (state.currentMapMode === 'photo3d') {
                sHeading = state.mapInstance.heading || 0;
                sTilt = state.mapInstance.tilt || 0;
            } else if (state.currentMapMode === 'vector3d') {
                sHeading = state.mapInstance.getHeading() || 0;
                sTilt = state.mapInstance.getTilt() || 0;
            }
        }
    });

    // 3. Translate mouse drag into flawless Orbit & Tilt
    document.addEventListener('mousemove', e => {
        if (!isRightDragging || !state.mapInstance || state.currentMapMode === 'flat') return;
        
        const dX = (e.clientX - sX) * 0.6; // Sensitivity
        const dY = (e.clientY - sY) * 0.6; 
        
        const newHeading = sHeading - dX; 
        
        // FIXED: Pushing UP (negative dY) now correctly increases tilt (looks at horizon)
        // Pulling DOWN (positive dY) decreases tilt (looks straight down at 0)
        const maxTilt = state.currentMapMode === 'photo3d' ? 90 : 67.5;
        const newTilt = Math.max(0, Math.min(sTilt - dY, maxTilt)); 

        if (state.currentMapMode === 'photo3d') {
            state.mapInstance.heading = newHeading;
            state.mapInstance.tilt = newTilt;
        } else if (state.currentMapMode === 'vector3d') {
            state.mapInstance.setHeading(newHeading);
            state.mapInstance.setTilt(newTilt);
        }
    });

    // 4. Release Camera
    document.addEventListener('mouseup', e => {
        if (e.button === 2) isRightDragging = false;
    });
}


export async function initMap(containerId, centerArray, zoom, pitch = 60, bearing = -17.6) {
    if (!window.google) {
        log("Waiting for Google Maps Engine...", true);
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    const parentContainer = document.getElementById(containerId);
    
    // --- FIX: Preserve Mobile Controls before wiping the map container ---
    let savedMobileControls = null;
    const existingMobileControls = document.getElementById('mobileMapControls');
    if (existingMobileControls && existingMobileControls.parentNode === parentContainer) {
        savedMobileControls = existingMobileControls;
        parentContainer.removeChild(savedMobileControls); // Safely detach it
    }
    
    if (state.mapInstance) {
        if (clusterer) clusterer.clearMarkers();
        googleMarkers.forEach(m => { if (m.remove) m.remove(); else m.map = null; });
        googleMarkers = [];
        state.mapInstance = null;
    }

    // Wipe the container to make room for the new map mode
    parentContainer.innerHTML = '';
    
    const mapWrapper = document.createElement('div');
    mapWrapper.style.width = '100%';
    mapWrapper.style.height = '100%';
    mapWrapper.style.position = 'absolute';
    mapWrapper.style.top = '0';
    mapWrapper.style.left = '0';
    mapWrapper.style.overflow = 'hidden'; // Add this line
    parentContainer.appendChild(mapWrapper);

    const centerLat = centerArray[1];
    const centerLng = centerArray[0];

    try {
        if (state.currentMapMode === 'photo3d') {
            // ==========================================
            // 1. 3D PHOTOREALISTIC ENGINE
            // ==========================================
            const { Map3DElement } = await google.maps.importLibrary("maps3d");
            
            state.mapInstance = new Map3DElement({
                center: { lat: centerLat, lng: centerLng, altitude: 0 },
                tilt: pitch,
                heading: bearing,
                range: Math.max(200, 40000 / Math.pow(2, zoom - 10)),
                defaultUIHidden: true,
                mode: 'SATELLITE' // <--- Changed from 'HYBRID' to completely remove icons/labels
            });

            state.mapInstance.flyTo = function(options) {
                const endCamera = {
                    center: { 
                        lat: options.center ? options.center[1] : this.center.lat, 
                        lng: options.center ? options.center[0] : this.center.lng, 
                        altitude: 20 
                    },
                    tilt: options.pitch !== undefined ? options.pitch : this.tilt,
                    heading: options.bearing !== undefined ? options.bearing : this.heading,
                    // Prioritize exact range in meters, fallback to calculating via zoom
                    range: options.range !== undefined ? options.range : (options.zoom ? Math.max(50, 40000 / Math.pow(2, options.zoom - 9)) : this.range)
                };
                this.flyCameraTo({ endCamera, durationMillis: 2000 });
            };

            mapWrapper.appendChild(state.mapInstance);

        } else {
            // ==========================================
            // 2 & 3. 2D HYBRID & 3D ROADMAP ENGINE
            // ==========================================
            const isFlat = state.currentMapMode === 'flat';
            
            state.mapInstance = new google.maps.Map(mapWrapper, {
                center: { lat: centerLat, lng: centerLng },
                zoom: isFlat ? zoom + 1.5 : zoom,
                tilt: isFlat ? 0 : pitch,
                heading: isFlat ? 0 : bearing,
                mapId: GOOGLE_MAP_ID,
                disableDefaultUI: true,
                mapTypeId: isFlat ? 'hybrid' : 'roadmap',
                gestureHandling: 'greedy'
            });

            state.mapInstance.flyTo = function(options) {
                if (options.center) this.panTo({ lat: options.center[1], lng: options.center[0] });
                
                let targetZoom = options.zoom;
                if (targetZoom && isFlat) targetZoom += 1.5; 
                if (targetZoom) this.setZoom(targetZoom);
                
                if (options.pitch !== undefined && !isFlat) this.setTilt(options.pitch);
                if (options.bearing !== undefined && !isFlat) this.setHeading(options.bearing);
            };

            clusterer = new markerClusterer.MarkerClusterer({ 
                map: state.mapInstance, 
                markers: [],
                renderer: {
                    render: ({ count, position }) => {
                        const el = document.createElement('div');
                        el.style.backgroundColor = '#0284c7';
                        el.style.color = 'white';
                        el.style.border = '3px solid white';
                        el.style.borderRadius = '50%';
                        el.style.width = '36px';
                        el.style.height = '36px';
                        el.style.display = 'flex';
                        el.style.alignItems = 'center';
                        el.style.justifyContent = 'center';
                        el.style.fontWeight = 'bold';
                        el.style.boxShadow = '0 4px 10px rgba(0,0,0,0.3)';
                        el.innerText = count;
                        return new google.maps.marker.AdvancedMarkerElement({ position, content: el });
                    }
                }
            });
        }

        // Mount UI buttons to the parent container so they always sit above the maps
        if (containerId !== 'loginMapBackground') {
            setupCustomUI(parentContainer, containerId, [centerLng, centerLat], zoom);
        }

        // --- FIX: Restore the mobile controls after the new map mode loads ---
        if (savedMobileControls) {
            parentContainer.appendChild(savedMobileControls);
        }

        state.mapInstance.loaded = () => true;
        return state.mapInstance;

    } catch (error) { 
        log('Map Init Error: ' + error.message, true); 
    }
}

// ==========================================
// DYNAMIC MARKER RENDERING
// ==========================================
export async function addMarkers(list) {
    if (!state.mapInstance || !window.google) return;
    
    // Clear old markers and clusters
    if (clusterer) clusterer.clearMarkers();
    googleMarkers.forEach(m => { if (m.remove) m.remove(); else m.map = null; });
    googleMarkers = [];

    // Import the native PinElement for all maps
    const { PinElement } = await google.maps.importLibrary("marker"); 
    let Marker3DInteractiveElement;

    // Only import the 3D marker library if we are actually in Photo 3D mode
    if (state.currentMapMode === 'photo3d') {
        const maps3d = await google.maps.importLibrary("maps3d");
        Marker3DInteractiveElement = maps3d.Marker3DInteractiveElement;
    }

    list.forEach(p => {
        if (p.lat && p.lng) {
            // 1. Get Job Status & Assign Color
            const { status } = getPremiseDisplayData(p);
            const safeStatus = (status || '').toLowerCase();
            
            let pinColor = '#00264b'; 
            if (safeStatus === 'complete') pinColor = '#10b981'; 
            else if (safeStatus === 'new') pinColor = '#0ea5e9'; 
            else if (safeStatus === 'inspection') pinColor = '#f59e0b'; 
            else if (safeStatus === 'report') pinColor = '#6366f1'; 
            else if (safeStatus === 'invoice') pinColor = '#f43f5e'; 

            // 2. Create the Universal Native Pin
            const pin = new PinElement({ 
                background: pinColor, 
                borderColor: 'white', 
                glyphColor: 'white', 
                scale: 1.2 
            });

            if (state.currentMapMode === 'photo3d' && Marker3DInteractiveElement) {
                // --- PHOTO 3D MARKER ---
                const marker = new Marker3DInteractiveElement({ 
                    position: { lat: p.lat, lng: p.lng, altitude: 50 }, 
                    altitudeMode: 'RELATIVE_TO_MESH', 
                    extruded: true 
                });
                
                marker.append(pin);
                marker.addEventListener('gmp-click', () => {
                    if (window.highlightSidebarCard) window.highlightSidebarCard(p.id);
                    showDetail(p);
                });

                state.mapInstance.append(marker);
                googleMarkers.push(marker);

            } else {
                // --- FLAT 2D & VECTOR 3D MARKER ---
                // Add tracking data so clicks and highlights still work
                pin.element.dataset.premiseId = p.id;
                if (state.currentViewedPremise && String(state.currentViewedPremise.id) === String(p.id)) {
                    pin.element.classList.add('marker-active');
                }

                // Inject the native pin into the 2D AdvancedMarker
                const marker = new google.maps.marker.AdvancedMarkerElement({ 
                    position: { lat: p.lat, lng: p.lng }, 
                    content: pin.element, 
                    title: p.name 
                });

                pin.element.addEventListener('click', () => {
                    highlightMarker(p.id);
                    if (window.highlightSidebarCard) window.highlightSidebarCard(p.id);
                    showDetail(p);
                });

                googleMarkers.push(marker);
            }
        }
    });

    // 3. Re-cluster the pins (Only runs in Flat/Vector modes)
    if (state.currentMapMode !== 'photo3d' && clusterer) {
        clusterer.addMarkers(googleMarkers);
    }
}

export function highlightMarker(premiseId) {
    document.querySelectorAll('.marker-active').forEach(el => el.classList.remove('marker-active'));
    if (premiseId) {
        const target = document.querySelector(`[data-premise-id="${premiseId}"]`);
        if (target) target.classList.add('marker-active');
    }
}

export function updateMarkerVisibility(visiblePremiseIds) {
    if (!state.mapInstance || !window.google) return;
    
    const visibleSet = new Set(visiblePremiseIds);
    let visibleGoogleMarkers = [];

    googleMarkers.forEach(marker => {
        // AdvancedMarkerElement stores the pin element in .content
        const pinElement = marker.content; 
        if (!pinElement) return;

        const pId = pinElement.dataset.premiseId;
        const isVisible = visibleSet.has(pId);

        if (state.currentMapMode === 'photo3d') {
            // Marker3DInteractiveElement API
            marker.position = isVisible ? marker.position : null; 
        } else {
            // AdvancedMarkerElement API
            marker.map = isVisible ? state.mapInstance : null;
            if (isVisible) visibleGoogleMarkers.push(marker);
        }
    });

    // Re-cluster only the visible markers
    if (state.currentMapMode !== 'photo3d' && clusterer) {
        clusterer.clearMarkers();
        clusterer.addMarkers(visibleGoogleMarkers);
    }
}

// ==========================================
// UNIFIED MAPBOX-STYLE UI CONTROLS
// ==========================================
function setupCustomUI(parentContainer, containerId, centerArray, zoom) {
    const controlsGroup = document.createElement('div');
    controlsGroup.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
    controlsGroup.style.position = 'absolute';
    controlsGroup.style.bottom = '30px';
    controlsGroup.style.right = '24px';
    controlsGroup.style.zIndex = '1000'; 

    const btnModeToggle = document.createElement('button');
    btnModeToggle.className = 'icon-ctrl-btn';
    
    let icon, titleText;
    if (state.currentMapMode === 'flat') { 
        icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>`; 
        titleText = `Switch to Vector 3D`; 
    } else if (state.currentMapMode === 'vector3d') { 
        icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`; 
        titleText = `Switch to Photo 3D`; 
    } else { 
        icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`; 
        titleText = `Switch to 2D Hybrid`; 
    }
    
    btnModeToggle.innerHTML = icon;
    btnModeToggle.title = titleText;
    
    btnModeToggle.onclick = async () => {
        let cLat = centerArray[1], cLng = centerArray[0], cZoom = zoom, cPitch = 60, cBearing = -17.6;
        
        if (state.mapInstance) {
            if (state.currentMapMode === 'photo3d') {
                cLat = state.mapInstance.center.lat;
                cLng = state.mapInstance.center.lng;
                cPitch = state.mapInstance.tilt;
                cBearing = state.mapInstance.heading;
                cZoom = Math.max(1, Math.log2(40000 / state.mapInstance.range) + 10); 
            } else {
                const center = state.mapInstance.getCenter();
                if (center) { cLat = center.lat(); cLng = center.lng(); }
                cZoom = state.mapInstance.getZoom() || zoom;
                if (state.currentMapMode === 'flat') cZoom -= 1.5; 
                cPitch = state.mapInstance.getTilt() || 0;
                cBearing = state.mapInstance.getHeading() || 0;
            }
        }

        if (state.currentMapMode === 'flat') state.currentMapMode = 'vector3d';
        else if (state.currentMapMode === 'vector3d') state.currentMapMode = 'photo3d';
        else state.currentMapMode = 'flat';

        state.preventFlyTo = true;

        await initMap(containerId, [cLng, cLat], cZoom, cPitch, cBearing);
        addMarkers(state.premisesData);
    }; 

    // ALWAYS append the Mode Toggle (3D/2D)
    controlsGroup.appendChild(btnModeToggle); 

    // --- FIX: ADD RECENTER BUTTON ONLY TO PREMISES MAP ---
    // It is injected natively into the control group so it stacks perfectly!
    if (containerId === 'premisesMap') {
        const btnRecenter = document.createElement('button');
        btnRecenter.className = 'icon-ctrl-btn mobile-only';
        btnRecenter.title = "Recenter Map";
        btnRecenter.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`;
        btnRecenter.onclick = () => {
            if (window.recenterMap) window.recenterMap();
        };
        // Insert it BEFORE the mode toggle so it sits right on top of it
        controlsGroup.insertBefore(btnRecenter, btnModeToggle);
    }


    // --- FIX: RESTRICT DASHBOARD & ADMIN TOOLS TO THE MAIN ADMIN MAP ONLY ---
    if (containerId === 'adminMap') {
        
        // --- KPI Dashboard Toggle Button ---
        const btnStatsToggle = document.createElement('button');
        btnStatsToggle.className = 'icon-ctrl-btn';
        btnStatsToggle.title = "Toggle KPI Dashboard";
        btnStatsToggle.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`;
        
        btnStatsToggle.onclick = () => {
            const dash = document.getElementById('adminDashboardWidgets');
            if (dash) {
                const isHidden = dash.classList.contains('hidden') || dash.style.display === 'none';
                import('./ui.js').then(ui => ui.toggleDashboardOverlay(isHidden));
            }
        };
        controlsGroup.appendChild(btnStatsToggle);

        if (state.currentUser?.id === ADMIN_UUID) {
            const adminWrapper = document.createElement('div');
            adminWrapper.style.position = 'relative';

            const btnAdminToggle = document.createElement('button');
            btnAdminToggle.className = 'icon-ctrl-btn';
            btnAdminToggle.title = "Admin Tools";
            btnAdminToggle.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`;

            const menuContainer = document.createElement('div');
            menuContainer.style.position = 'absolute';
            menuContainer.style.bottom = '0'; 
            menuContainer.style.right = '50px'; 
            menuContainer.style.display = 'flex';
            menuContainer.style.flexDirection = 'column';
            menuContainer.style.gap = '8px';
            menuContainer.style.opacity = '0';
            menuContainer.style.pointerEvents = 'none';
            menuContainer.style.transform = 'translateX(10px)';
            menuContainer.style.transition = 'all 0.2s ease-out';
            menuContainer.style.background = 'rgba(255,255,255,0.9)';
            menuContainer.style.padding = '8px';
            menuContainer.style.borderRadius = '12px';
            menuContainer.style.boxShadow = '0 10px 30px rgba(0,0,0,0.15)';
            menuContainer.style.border = '1px solid rgba(255,255,255,0.8)';
            menuContainer.style.backdropFilter = 'blur(10px)';

            let isOpen = false;
            btnAdminToggle.onclick = () => {
                isOpen = !isOpen;
                if (isOpen) {
                    menuContainer.style.opacity = '1';
                    menuContainer.style.pointerEvents = 'all';
                    menuContainer.style.transform = 'translateX(0)';
                    btnAdminToggle.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
                } else {
                    menuContainer.style.opacity = '0';
                    menuContainer.style.pointerEvents = 'none';
                    menuContainer.style.transform = 'translateX(10px)';
                    btnAdminToggle.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`;
                }
            };

            const createMenuBtn = (title, iconHtml) => {
                const btn = document.createElement('button');
                btn.className = 'icon-ctrl-btn';
                btn.title = title;
                btn.style.position = 'relative'; 
                btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
                btn.innerHTML = iconHtml;
                return btn;
            };

            const btnWFMConnect = createMenuBtn("Connect WFM", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`);
            const btnXeroConnect = createMenuBtn("Connect Xero", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/><path d="M9.5 9.5l5 5m0-5l-5 5"/></svg>`);
            const btnXeroSync = createMenuBtn("Sync Budgets (Xero)", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`);
            const btnWFMJobs = createMenuBtn("Sync Jobs & Map", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`);
            const btnSyncLogos = createMenuBtn("Sync Client Logos", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`);
            const btnFix = createMenuBtn("Fix Missing Coordinates", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></svg>`);
            const btnSharePoint = createMenuBtn("Sync SharePoint Links", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M3 15h6"></path><path d="M3 18h6"></path><path d="M14 15h.01"></path><path d="M14 18h.01"></path></svg>`);
            const btnExtractDates = createMenuBtn("Extract PDF Dates (AI)", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`);
            const btnAutoPremise = createMenuBtn("Auto-Link Missing Premises (AI)", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path><path d="M12 2v4"></path><path d="M12 18v4"></path><path d="M4.93 4.93l2.83 2.83"></path><path d="M16.24 16.24l2.83 2.83"></path></svg>`);
            const btnCleanPremises = createMenuBtn("Normalize & Merge Duplicates (AI)", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><path d="M3.27 6.96L12 12.01l8.73-5.05"></path><path d="M12 22.08V12"></path><circle cx="12" cy="12" r="3" fill="white"></circle></svg>`);
            const btnWFMClientSync = createMenuBtn("Sync Missing Clients (WFM)", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`);
            const btnMergeTool = createMenuBtn("Manual Client Merge", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00264b" stroke-width="2"><path d="M16 3h5v5M8 21H3v-5M21 3l-7 7M3 21l7-7M15 14l6 6M9 10L3 4"></path></svg>`);
            
            menuContainer.append(btnWFMConnect, btnXeroConnect, btnXeroSync, btnWFMJobs, btnWFMClientSync, btnMergeTool, document.createElement('hr'), btnSyncLogos, btnFix, btnAutoPremise, btnCleanPremises, btnSharePoint, btnExtractDates);

            const statusBox = document.createElement('div');
            statusBox.className = 'auto-fix-status';
            statusBox.style.display = 'none';
            statusBox.style.right = '50px'; 
            
            adminWrapper.appendChild(menuContainer);
            adminWrapper.appendChild(btnAdminToggle);
            adminWrapper.appendChild(statusBox);

            controlsGroup.appendChild(adminWrapper);

            const loadingIcon = `<svg class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

            const disableBtns = (disable) => {
                [btnFix, btnSyncLogos, btnWFMConnect, btnXeroConnect, btnXeroSync, btnWFMJobs, btnSharePoint, btnAutoPremise, btnCleanPremises, btnWFMClientSync, btnMergeTool, btnExtractDates].forEach(b => b.disabled = disable);
                if (!disable) statusBox.style.display = 'none';
            };

            const runTool = async (startMsg, taskFn, defaultIcon, activeBtn) => {
                disableBtns(true); activeBtn.innerHTML = loadingIcon; statusBox.style.display = 'block'; statusBox.innerText = startMsg;
                try { 
                    const resultMsg = await taskFn(); 
                    statusBox.innerText = resultMsg; 
                    if (window.refreshAppAdminData) await window.refreshAppAdminData();
                } catch(e) { 
                    log("Tool Error: " + e.message, true); statusBox.innerText = e.message;
                } finally { 
                    setTimeout(() => { disableBtns(false); activeBtn.innerHTML = defaultIcon; }, 4000); 
                }
            };

            btnWFMConnect.onclick = () => window.connectWFM();

            btnXeroConnect.onclick = () => window.connectXero();

            btnXeroSync.onclick = () => window.openTargetedXeroSync();
            
            btnWFMJobs.onclick = async () => {
                const choice = prompt("Which jobs would you like to sync?\n\nType 'active' for current jobs only (Fast).\nType 'full' to include all historical jobs (Slow).", "active");
                if (!choice) return; 
                const syncScope = choice.toLowerCase().trim() === 'full' ? 'full' : 'active';
                runTool(`Syncing Jobs...`, async () => {
                    let currentPage = 1; let hasMore = true; let totalProcessed = 0; let allActiveIds = []; 
                    while (hasMore) {
                        statusBox.innerText = `Syncing (Page ${currentPage})...`;
                        const { data, error } = await supabase.functions.invoke('wfm-sync', { body: { mode: 'jobs', page: currentPage, syncScope: syncScope } });
                        if (error) throw error; if (data && data.error) throw new Error(data.error);
                        totalProcessed += data.count;
                        if (data.syncedIds && data.syncedIds.length > 0) allActiveIds.push(...data.syncedIds);
                        hasMore = data.hasMore; if (hasMore) currentPage = data.nextPage;
                    }
                    if (syncScope === 'active' && allActiveIds.length > 0) {
                        statusBox.innerText = `Cleaning up completed jobs...`;
                        await supabase.functions.invoke('wfm-sync', { body: { mode: 'reconcile_jobs', activeIds: allActiveIds } });
                    }
                    return `Success! Synced ${totalProcessed} jobs.`;
                }, btnWFMJobs.innerHTML, btnWFMJobs);
            };        
            
            btnSyncLogos.onclick = async () => runTool("Syncing Logos...", async () => {
                const { data: files } = await supabase.storage.from('GEOMAP-Images').list('', { limit: 1000 });
                let count = 0;
                for (const client of state.clientsData) {
                    const file = files.find(f => f.name.split('.')[0].trim().toLowerCase() === (client.name||'').trim().toLowerCase());
                    if (file) {
                        const { data } = supabase.storage.from('GEOMAP-Images').getPublicUrl(file.name);
                        if (client.logo_url !== data.publicUrl) {
                            await supabase.from('clients').update({ logo_url: data.publicUrl }).eq('id', client.id); count++;
                        }
                    }
                }
                return `Synced ${count} logos.`;
            }, btnSyncLogos.innerHTML, btnSyncLogos);

            btnFix.onclick = async () => runTool("Fixing Coordinates...", async () => {
                let allPremises = []; let fetchMore = true; let from = 0; const step = 999;
                while (fetchMore) {
                    const { data, error } = await supabase.from('premises').select('*').range(from, from + step);
                    if (error) return `DB Error: ${error.message}`;
                    if (data && data.length > 0) { allPremises.push(...data); from += (step + 1); }
                    if (!data || data.length <= step) { fetchMore = false; }
                }

                const missing = allPremises.filter(p => (p.lat === null || p.lat === undefined || p.lat === '') && p.address && p.address.trim() !== '');
                if (missing.length === 0) return "No valid addresses to fix!";
                
                let count = 0;
                for (const p of missing) {
                    try {
                        let query = encodeURIComponent(p.address);
                        let res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${MAPBOX_TOKEN}&country=nz,au&limit=1`);
                        let json = await res.json();
                        if (!json.features || json.features.length === 0) {
                            let fallbackQuery = encodeURIComponent(p.address.replace(/^[A-Z0-9]+\//i, '').replace(/^(\d+)-(\d+)/, '$1').replace(/&.*?(?=\s[A-Z])/i, '').trim());
                            res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${fallbackQuery}.json?access_token=${MAPBOX_TOKEN}&country=nz,au&limit=1`);
                            json = await res.json();
                        }
                        if (json.features?.length > 0) {
                            const { error: updateErr } = await supabase.from('premises').update({ lat: json.features[0].center[1], lng: json.features[0].center[0] }).eq('id', p.id);
                            if (!updateErr) { count++; statusBox.innerText = `Fixed ${count} of ${missing.length}`; }
                        }
                    } catch(e) { console.log(`Error checking: ${p.address}`); }
                }
                return `Complete! Fixed ${count} locations.`;
            }, btnFix.innerHTML, btnFix);

            btnSharePoint.onclick = async () => runTool("Syncing SharePoint...", async () => {
                let totalSynced = 0; 
                let totalChecked = 0; 
                let hasMore = true; 
                let currentCursor = null; 
                
                while (hasMore) {
                    statusBox.innerText = `Scanning SP batch... (${totalSynced} synced so far)`;
                    
                    const { data, error } = await supabase.functions.invoke('sharepoint-sync', { 
                        body: { lastJobNumber: currentCursor }
                    });
                    
                    if (error) throw error; 
                    if (data && data.error) throw new Error(data.error);
                    
                    totalSynced += (data.count || 0); 
                    totalChecked += (data.dbCount || 0); 
                    hasMore = data.hasMore; 
                    currentCursor = data.nextJobNumber;

                    if (!hasMore || data.count === undefined) break;
                }
                
                return `SP Complete! Checked ${totalChecked} reports. Synced ${totalSynced} folders.`;
            }, btnSharePoint.innerHTML, btnSharePoint);

            btnExtractDates.onclick = async () => runTool("Extracting PDF Dates...", async () => {
                let totalUpdated = 0; 
                let hasMore = true; 
                let currentCursor = null; // Changed to start at null
                
                while (hasMore) {
                    statusBox.innerText = `Scanning PDF Batch... (${totalUpdated} updated so far)`;
                    
                    // Passing 'lastJobNumber' instead of 'lastId'
                    const { data, error } = await supabase.functions.invoke('extract-pdf-dates', {
                        body: { lastJobNumber: currentCursor } 
                    });
                    
                    if (error) throw error; 
                    if (data && data.error) throw new Error(data.error);
                    
                    totalUpdated += (data.count || 0); 
                    currentCursor = data.nextJobNumber; // Grabs the next Job Number from the backend
                    hasMore = data.hasMore; 

                    if (!hasMore) break;
                }
                
                return `Extraction Complete! Sourced dates for ${totalUpdated} reports.`;
            }, btnExtractDates.innerHTML, btnExtractDates);

            btnAutoPremise.onclick = async () => runTool("Auto-Linking Premises...", async () => {
                let totalProcessed = 0; 
                let hasMore = true; 
                let batches = 0;
                let currentCursor = null; 

                while (hasMore) {
                    statusBox.innerText = `AI analyzing batch ${batches + 1}... (${totalProcessed} linked so far)`;
                    
                    const { data, error } = await supabase.functions.invoke('auto-premise', { 
                        body: { lastId: currentCursor } 
                    });
                    
                    if (error) throw error; 
                    if (data && data.error) throw new Error(data.error);
                    
                    totalProcessed += (data.processed || 0); 
                    currentCursor = data.nextId;
                    hasMore = data.hasMore; 
                    batches++;
                }
                
                return `Complete! AI successfully linked ${totalProcessed} premises.`;
            }, btnAutoPremise.innerHTML, btnAutoPremise);

            btnCleanPremises.onclick = async () => runTool("Merging Duplicates...", async () => {
                const { data, error } = await supabase.functions.invoke('clean-premises');
                
                if (error) throw error; 
                if (data && data.error) throw new Error(data.error);
                
                if (data.errors && data.errors.length > 0) {
                    console.error("Merge Blockers:", data.errors);
                    return `Merged ${data.merged}. BLOCKED BY: ${data.errors[0].split('on table')[1] || data.errors[0]}`;
                }
                
                return `Complete! Safely merged ${data.merged || 0} duplicate premises.`;
            }, btnCleanPremises.innerHTML, btnCleanPremises);

            btnWFMClientSync.onclick = async () => runTool("Syncing Clients from WFM...", async () => {
                let totalSynced = 0; 
                let totalChecked = 0; 
                let hasMore = true; 
                let currentCursor = null; 
                
                while (hasMore) {
                    statusBox.innerText = `Querying WFM batch... (${totalSynced} linked so far)`;
                    
                    const { data, error } = await supabase.functions.invoke('wfm-client-sync', { 
                        body: { lastJobNumber: currentCursor }
                    });
                    
                    if (error) throw error; 
                    if (data && data.error) throw new Error(data.error);
                    
                    totalSynced += (data.count || 0); 
                    totalChecked += (data.dbCount || 0); 
                    hasMore = data.hasMore; 
                    currentCursor = data.nextJobNumber;

                    if (!hasMore) break;
                }
                
                return `WFM Complete! Checked ${totalChecked} reports. Linked ${totalSynced} clients.`;
            }, btnWFMClientSync.innerHTML, btnWFMClientSync);

            btnMergeTool.onclick = () => {
                const sortedClients = [...state.clientsData].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                const masterOptionsHtml = sortedClients.map(c => `<option value="${c.id}">${c.name} (${c.count || 0} properties)</option>`).join('');
                const duplicateCheckboxesHtml = sortedClients.map(c => {
                    const count = c.count || 0;
                    const badgeColor = count === 0 ? '#ef4444' : '#64748b'; 
                    const badgeBg = count === 0 ? '#fef2f2' : '#f1f5f9';
                    return `
                    <label class="dup-item" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #e2e8f0; font-size: 13px; transition: 0.2s;" data-count="${count}">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <input type="checkbox" class="dup-checkbox" value="${c.id}" data-name="${(c.name || '').toLowerCase().replace(/"/g, '&quot;')}">
                            <span style="color: #0f172a; font-weight: 500;">${c.name}</span>
                        </div>
                        <span style="font-size: 10px; font-weight: 600; color: ${badgeColor}; background: ${badgeBg}; padding: 3px 8px; border-radius: 12px; border: 1px solid ${count === 0 ? '#fca5a5' : '#e2e8f0'};">
                            ${count} properties
                        </span>
                    </label>
                    `;
                }).join('');

                const modalHtml = `
                <div id="dynamicMergeModal" class="modal-overlay active sub-modal" style="z-index: 99999;">
                    <div class="modal-card" style="width: 600px;">
                        <div class="modal-header">
                            <div>
                                <h2>Batch Merge & Clean Clients</h2>
                                <h4>Merge duplicates into a Master, or bulk-delete empty clients.</h4>
                            </div>
                            <button class="modal-close" onclick="document.getElementById('dynamicMergeModal').remove()">✕</button>
                        </div>
                        <div class="modal-body">
                            <div class="form-group">
                                <label class="form-label" style="color: #0284c7;">1. Keep This Client (MASTER) <span style="font-weight: 400; color: #64748b;">- Only needed for merging</span></label>
                                <div style="display: flex; gap: 8px;">
                                    <select id="mergeMaster" class="form-input" style="flex: 1; cursor:pointer;">
                                        <option value="" disabled selected>Select the Master Client...</option>
                                        ${masterOptionsHtml}
                                    </select>
                                    <button type="button" id="quickCreateMasterBtn" class="btn-access" style="width: auto; padding: 0 16px; background: #10b981; border-color: #10b981; font-weight: 700;">+ New Master</button>
                                </div>
                            </div>
                            
                            <div class="form-group" style="margin-top: 24px;">
                                <label class="form-label" style="display: flex; justify-content: space-between;">
                                    <span style="color: #ef4444;">2. Search & Select Clients</span>
                                    <span id="dupCount" style="color: #64748b; font-size: 11px;">0 selected</span>
                                </label>
                                
                                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                                    <input type="text" id="mergeDupSearch" class="form-input" placeholder="🔍 Search to filter list..." style="flex: 1; border-color: #cbd5e1;">
                                    <button type="button" id="selectEmptyBtn" class="btn-cancel" style="padding: 0 16px; font-size: 11px; white-space: nowrap; height: 44px; color: #ef4444; border-color: #fca5a5; background: #fef2f2;">Select All "0" Properties</button>
                                </div>
                                
                                <div id="mergeDupList" style="height: 250px; overflow-y: auto; border: 2px solid #e2e8f0; border-radius: 8px; background: #f8fafc; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">
                                    ${duplicateCheckboxesHtml}
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer" style="display: flex; justify-content: space-between;">
                            <button type="button" class="btn-cancel" id="deleteOnlyBtn" style="color: #ef4444; border-color: #ef4444; background: #fff;">Delete Selected (No Merge)</button>
                            <div style="display: flex; gap: 12px;">
                                <button type="button" class="btn-cancel" id="shareOnlyBtn" style="color: #10b981; border-color: #10b981; background: #f0fdf4;">Share Only (Keep Both)</button>
                                <button type="button" class="btn-cancel" onclick="document.getElementById('dynamicMergeModal').remove()">Cancel</button>
                                <button type="button" class="btn-access" id="confirmMergeBtn" style="width: auto; background: #0284c7; border-color: #0284c7;">Merge into Master</button>
                            </div>
                        </div>
                    </div>
                </div>`;

                document.body.insertAdjacentHTML('beforeend', modalHtml);

                document.getElementById('quickCreateMasterBtn').onclick = async () => {
                    const newName = prompt("Enter the exact name for the NEW Master Client:");
                    if (!newName || !newName.trim()) return;

                    const btn = document.getElementById('quickCreateMasterBtn');
                    const originalText = btn.innerText;
                    btn.innerText = '⏳ Saving...';
                    btn.disabled = true;

                    try {
                        const { data, error } = await supabase.functions.invoke('merge-clients', {
                            body: { newName: newName.trim(), mode: 'create_master' }
                        });
                        
                        if (error) throw error;
                        if (data && data.error) throw new Error(data.error);

                        const newClient = data.client;
                        newClient.count = 0;
                        
                        state.clientsData.push(newClient);
                        
                        const masterSelect = document.getElementById('mergeMaster');
                        const newOption = new Option(`${newClient.name} (0 properties)`, newClient.id);
                        masterSelect.add(newOption);
                        masterSelect.value = newClient.id;

                        btn.style.background = '#0ea5e9';
                        btn.style.borderColor = '#0ea5e9';
                        btn.innerText = '✓ Created!';
                        setTimeout(() => {
                            btn.style.background = '#10b981';
                            btn.style.borderColor = '#10b981';
                            btn.innerText = originalText;
                            btn.disabled = false;
                        }, 2000);

                    } catch (err) {
                        alert("Failed to create new client: " + err.message);
                        btn.innerText = originalText;
                        btn.disabled = false;
                    }
                };

                document.getElementById('mergeDupSearch').addEventListener('input', (e) => {
                    const term = e.target.value.toLowerCase().trim();
                    document.querySelectorAll('.dup-item').forEach(label => {
                        const checkbox = label.querySelector('.dup-checkbox');
                        label.style.display = checkbox.dataset.name.includes(term) ? 'flex' : 'none';
                    });
                });

                document.getElementById('selectEmptyBtn').onclick = () => {
                    document.querySelectorAll('.dup-item').forEach(label => {
                        const count = parseInt(label.dataset.count || '0');
                        const checkbox = label.querySelector('.dup-checkbox');
                        if (count === 0 && label.style.display !== 'none') {
                            checkbox.checked = true;
                        }
                    });
                    document.getElementById('mergeDupList').dispatchEvent(new Event('change'));
                };

                document.getElementById('mergeDupList').addEventListener('change', () => {
                    const count = document.querySelectorAll('.dup-checkbox:checked').length;
                    document.getElementById('dupCount').innerText = `${count} selected`;
                    
                    document.querySelectorAll('.dup-item').forEach(label => {
                        label.style.background = label.querySelector('.dup-checkbox').checked ? '#e0f2fe' : 'transparent';
                    });
                });

                document.getElementById('confirmMergeBtn').onclick = async () => {
                    const masterId = document.getElementById('mergeMaster').value;
                    const masterName = document.getElementById('mergeMaster').options[document.getElementById('mergeMaster').selectedIndex]?.text;
                    
                    const duplicateIds = Array.from(document.querySelectorAll('.dup-checkbox:checked')).map(cb => cb.value);

                    if (!masterId) return alert("Please select a Master Client.");
                    if (duplicateIds.length === 0) return alert("Please select at least one duplicate client to merge.");
                    if (duplicateIds.includes(masterId)) return alert("You cannot select the Master Client as one of the duplicates! Please uncheck it.");

                    if (confirm(`FINAL WARNING:\n\nKEEP: ${masterName}\nMERGE & DELETE: ${duplicateIds.length} client(s)\n\nAll reports for the duplicates will be moved to the Master. This CANNOT be undone. Proceed?`)) {
                        document.getElementById('dynamicMergeModal').remove(); 
                        
                        runTool(`Merging ${duplicateIds.length} clients...`, async () => {
                            const { data, error } = await supabase.functions.invoke('merge-clients', {
                                body: { masterId: masterId, duplicateIds: duplicateIds, mode: 'merge' } 
                            });
                            if (error) throw error; 
                            if (data && data.error) throw new Error(data.error);
                            return `Successfully merged ${duplicateIds.length} client(s) into ${masterName}.`;
                        }, btnMergeTool.innerHTML, btnMergeTool);
                    }
                };

                document.getElementById('deleteOnlyBtn').onclick = async () => {
                    const checkedBoxes = Array.from(document.querySelectorAll('.dup-checkbox:checked'));
                    const duplicateIds = checkedBoxes.map(cb => cb.value);

                    if (duplicateIds.length === 0) return alert("Please select at least one client to delete.");

                    const hasProperties = checkedBoxes.some(cb => parseInt(cb.closest('.dup-item').dataset.count || '0') > 0);
                    
                    let msg = `WARNING: You are about to permanently DELETE ${duplicateIds.length} client(s) WITHOUT merging them.\n\nThis will destroy their login accounts.`;
                    if (hasProperties) {
                        msg += `\n\n🚨 DANGER: Some selected clients HAVE PROPERTIES attached! Deleting them may orphan records.`;
                    }
                    msg += `\n\nAre you sure you want to proceed?`;

                    if (confirm(msg)) {
                        document.getElementById('dynamicMergeModal').remove();
                        
                        runTool(`Deleting ${duplicateIds.length} clients...`, async () => {
                            const { data, error } = await supabase.functions.invoke('merge-clients', {
                                body: { masterId: null, duplicateIds: duplicateIds, mode: 'delete_only' } 
                            });
                            if (error) throw error; 
                            if (data && data.error) throw new Error(data.error);
                            return `Successfully deleted ${duplicateIds.length} client(s).`;
                        }, btnMergeTool.innerHTML, btnMergeTool);
                    }
                };

                // --- NEW: SHARE ONLY BUTTON LOGIC ---
                document.getElementById('shareOnlyBtn').onclick = async () => {
                    const masterId = document.getElementById('mergeMaster').value;
                    const masterName = document.getElementById('mergeMaster').options[document.getElementById('mergeMaster').selectedIndex]?.text;
                    
                    const checkedBoxes = Array.from(document.querySelectorAll('.dup-checkbox:checked'));
                    const duplicateIds = checkedBoxes.map(cb => cb.value);

                    if (!masterId) return alert("Please select a Master Client to share with.");
                    if (duplicateIds.length === 0) return alert("Please select at least one client to share properties from.");
                    if (duplicateIds.includes(masterId)) return alert("You cannot share a client with itself! Please uncheck the Master.");

                    if (confirm(`SHARE REPORTS:\n\nTarget: ${masterName}\nSharing From: ${duplicateIds.length} client(s)\n\nBoth clients will remain completely active and separate, but ${masterName} will be granted access to the selected clients' reports. Proceed?`)) {
                        document.getElementById('dynamicMergeModal').remove(); 
                        
                        runTool(`Sharing reports from ${duplicateIds.length} clients...`, async () => {
                            const { data, error } = await supabase.functions.invoke('merge-clients', {
                                body: { masterId: masterId, duplicateIds: duplicateIds, mode: 'share_only' } 
                            });
                            if (error) throw error; 
                            if (data && data.error) throw new Error(data.error);
                            return `Successfully shared access with ${masterName}.`;
                        }, btnMergeTool.innerHTML, btnMergeTool);
                    }
                };
            };
        } 
    } 

    parentContainer.appendChild(controlsGroup);
}