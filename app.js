// app.js

// 1. Imports
import { state } from '../store.js';
import { ADMIN_UUID } from '../config.js';
import { supabase, loginUser, getAdminData, getClientPremises, getClientById, getUserRole } from './api.js';
import { initMap, addMarkers, highlightMarker } from '../map.js';
import { 
    log, toggleDashboardOverlay, renderBICharts, filterAdminView, 
    loadClientView, showDetail, updateGalleryImage, switchScreen, 
    renderFilterDropdown, normalizeStatus, getPremiseDisplayData 
} from '../ui.js';
import '../modals.js'; // Running this executes the modal setup code

// 2. Global Hooks for Inline HTML Event Handlers

window.switchChart = (type, btnElement) => {
    // Handle UI button active state
    document.querySelectorAll('.chart-tab').forEach(el => el.classList.remove('active'));
    btnElement.classList.add('active');
    
    // Render the new chart using the ui.js function
    import('../ui.js').then(ui => {
        ui.renderBICharts(state.premisesData, state.allReportsData, type);
    });
};

window.filterDashboard = (filterType, cardElement) => {
    // 1. Highlight the clicked card
    document.querySelectorAll('.stat-card').forEach(el => el.classList.remove('active-filter'));
    cardElement.classList.add('active-filter');

    // 2. Filter map markers and left sidebar list based on KPI clicked
    import('../ui.js').then(ui => {
        let filteredPremises = [];
        
        if (filterType === 'all') {
            filteredPremises = state.premisesData;
            state.currentAdminSubFilter = 'all'; 
        } else {
            // Find reports matching the condition
            const matchingReports = state.allReportsData.filter(job => {
                const status = ui.normalizeStatus(job.status);
                if (filterType === 'active') return !['complete','invoice','cancelled'].includes(status);
                if (filterType === 'inspect') return status === 'new';
                if (filterType === 'invoice') return ['report','advice'].includes(status);
                return false;
            });
            
            // Get unique premises for those reports
            const premiseIds = new Set(matchingReports.map(r => r.premise_id));
            filteredPremises = state.premisesData.filter(p => premiseIds.has(p.id));
            
            // Sync sidebar filter
            if (filterType === 'inspect') state.currentAdminSubFilter = 'new';
            else state.currentAdminSubFilter = 'all'; // Default back to all for complex filters
        }

        // 3. Update Map
        import('../map.js').then(mapMod => {
            mapMod.addMarkers(filteredPremises);
        });

        // 4. Update Sidebar
        ui.filterAdminView(); 
    });
};

// --- GLOBAL XERO SWEEPER UI ---
// Kept the function name openTargetedXeroSync so we don't break map.js bindings!
window.openTargetedXeroSync = async () => {
    const modal = document.getElementById('xeroMappingModal');
    const loading = document.getElementById('mappingLoading');
    const content = document.getElementById('mappingContent');
    
    modal.style.display = 'flex';
    loading.style.display = 'none'; // We don't need to load clients anymore
    content.style.display = 'block';

    content.innerHTML = `
        <div style="padding: 24px; text-align: center; background: #f8fafc; border-bottom: 1px solid #e2e8f0; border-radius: 8px;">
            <h3 style="margin-top: 0; color: #0f172a; font-size: 16px;">Global Budget Sweeper</h3>
            <p style="font-size: 12px; color: #64748b; margin-bottom: 20px;">
                Automatically scans Xero for your newest unbudgeted jobs (Highest number first). Excludes jobs marked as 'New' or 'Cancelled'.
            </p>

            <button id="runGlobalSyncBtn" style="width: 100%; background: #10b981; color: white; border: none; padding: 14px; border-radius: 8px; font-weight: 800; font-size: 14px; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 10px rgba(16, 185, 129, 0.2);">
                START GLOBAL SWEEP
            </button>
            
            <div id="syncResultBox" style="margin-top: 20px; font-size: 12px; color: #0284c7; font-weight: 600; min-height: 20px; padding: 10px; border-radius: 6px; display: none; text-align: left; max-height: 250px; overflow-y: auto;"></div>
        </div>
    `;

    document.getElementById('runGlobalSyncBtn').onclick = async function() {
        const btn = this;
        const resBox = document.getElementById('syncResultBox');
        
        btn.innerHTML = "⏳ Scanning Latest Jobs...";
        btn.disabled = true;
        btn.style.background = "#94a3b8";
        resBox.style.display = 'none';

        try {
            // Empty body request! The Edge Function figures out what to do automatically.
            const { data, error } = await supabase.functions.invoke('xero-budget-sync', { body: {} });

            if (error) throw error;
            if (data.error) throw new Error(data.error);

            resBox.style.display = 'block';
            resBox.style.background = '#f0fdf4';
            resBox.style.border = '1px solid #10b981';
            resBox.style.color = '#047857';
            
            let detailsHtml = (data.details || []).map(d => `<div style="margin-top:6px;">${d}</div>`).join('');
            resBox.innerHTML = `<div style="margin-bottom: 8px;"><strong>${data.message}</strong></div>${detailsHtml}`;

            if (window.refreshAppAdminData) await window.refreshAppAdminData();

        } catch (err) {
            resBox.style.display = 'block';
            resBox.style.background = '#fef2f2';
            resBox.style.border = '1px solid #ef4444';
            resBox.style.color = '#b91c1c';
            resBox.innerHTML = `❌ Error: ${err.message}`;
        } finally {
            btn.innerHTML = "START GLOBAL SWEEP";
            btn.disabled = false;
            btn.style.background = "#10b981";
        }
    };
};

window.switchAdminTab = (type) => {
    state.activeAdminTab = type;
    document.getElementById('tabClientsBtn').classList.toggle('active', type === 'clients');
    document.getElementById('tabReportsBtn').classList.toggle('active', type === 'reports');
    document.getElementById('tabContactsBtn').classList.toggle('active', type === 'contacts');
    document.getElementById('tabQuotesBtn').classList.toggle('active', type === 'quotes'); // <-- ADD THIS
    
    // Show/Hide the pinned Add Contact button
    const addContactWrapper = document.getElementById('adminAddContactWrapper');
    if (addContactWrapper) {
        addContactWrapper.style.display = type === 'contacts' ? 'block' : 'none';
    }
    
    state.currentAdminSubFilter = 'all';
    renderFilterDropdown(type);
    filterAdminView();
};

window.triggerClientLoad = async (clientId) => {
    toggleDashboardOverlay(false);
    const client = state.clientsData.find(c => c.id === clientId);
    state.currentUser = { role: 'admin', name: 'Bayleys Admin', id: ADMIN_UUID, clientSpoof: client };
    document.getElementById('backToAdminBtn').style.display = 'block';
    
    await window.fetchAppClientPremises(client.id);
    switchScreen('premisesScreen');
    loadClientView();
};

window.highlightSidebarCard = (targetId) => {
    // 1. Remove highlight from all cards
    document.querySelectorAll('.card-item').forEach(card => card.classList.remove('active-card'));
    
    if (!targetId) return;

    // 2. Find the precise card and scroll to it ONCE
    let foundCard = null;
    document.querySelectorAll('.card-item').forEach(card => {
        const onclickText = card.getAttribute('onclick') || '';
        // Checking for the exact ID wrapped in quotes prevents false matches and duplicates
        if (onclickText.includes(`'${targetId}'`) && !foundCard) {
            card.classList.add('active-card');
            foundCard = card; 
        }
    });

    if (foundCard) {
        foundCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
};

window.triggerDetailLoad = (premiseId, reportId = null) => {
    const p = state.premisesData.find(x => String(x.id) === String(premiseId));
    if (p) {
        import('../map.js').then(mapMod => mapMod.highlightMarker(p.id));
        
        // Pass the reportId if we clicked a report, otherwise fallback to the premiseId
        window.highlightSidebarCard(reportId || p.id);
        
        // Pass the reportId into the UI so it can feature the correct data!
        showDetail(p, reportId);
    }
};

// --- ADD THIS GLOBALLY IN app.js ---
window.enablePinMoveMode = (premise) => {
    // 1. Create a persistent toast notification so the user knows what to do
    let toast = document.getElementById('pinMoveToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'pinMoveToast';
        toast.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #10b981; color: white; padding: 12px 24px; border-radius: 30px; font-weight: 600; font-size: 14px; z-index: 99999; box-shadow: 0 10px 25px rgba(0,0,0,0.3); display: flex; align-items: center; gap: 10px; pointer-events: none;';
        document.body.appendChild(toast);
    }
    toast.innerHTML = `🎯 Click anywhere on the map to place the new pin for ${premise.name}. (Press ESC to cancel)`;
    toast.style.display = 'flex';

    const map = state.mapInstance;
    if (!map) return;

    // 2. Change cursor to a crosshair to indicate "Target Mode"
    const mapDivs = document.querySelectorAll('#adminMap, #premisesMap, gmp-map-3d');
    mapDivs.forEach(el => el.style.cursor = 'crosshair');

    let isCancelled = false;

    // 3. Allow cancellation via the Escape key
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            isCancelled = true;
            cleanup();
        }
    };
    document.addEventListener('keydown', escapeHandler);

    // 4. Handle the map click event natively across both engines
    const clickHandler = async (e) => {
        if (isCancelled) return;
        
        let newLat, newLng;
        if (state.currentMapMode === 'photo3d') {
            if (!e.position) return;
            newLat = e.position.lat;
            newLng = e.position.lng;
        } else {
            if (!e.latLng) return;
            newLat = e.latLng.lat();
            newLng = e.latLng.lng();
        }

        cleanup(); // Remove listeners and crosshairs instantly

        if (confirm(`Update the location for ${premise.name}?`)) {
            try {
                // Update DB securely
                const { error } = await supabase.from('premises').update({ lat: newLat, lng: newLng }).eq('id', premise.id);
                if (error) throw error;

                // Update local State memory so it persists without a full refresh
                const pIndex = state.premisesData.findIndex(x => String(x.id) === String(premise.id));
                if (pIndex > -1) {
                    state.premisesData[pIndex].lat = newLat;
                    state.premisesData[pIndex].lng = newLng;
                }

                // Update UI Map and snap the camera to the newly fixed pin
                import('../map.js').then(mapMod => {
                    mapMod.addMarkers(state.premisesData);
                    mapMod.highlightMarker(premise.id);
                    map.flyTo({ center: [newLng, newLat], pitch: 60, range: 150 });
                });
                
            } catch (err) {
                alert("Failed to update location: " + err.message);
            }
        }
    };

    const cleanup = () => {
        if (state.currentMapMode === 'photo3d') {
            map.removeEventListener('gmp-click', clickHandler);
        } else {
            google.maps.event.clearListeners(map, 'click');
        }
        document.removeEventListener('keydown', escapeHandler);
        mapDivs.forEach(el => el.style.cursor = '');
        toast.style.display = 'none';
    };

    // 5. Attach the listener depending on map engine
    if (state.currentMapMode === 'photo3d') {
        map.addEventListener('gmp-click', clickHandler);
    } else {
        map.addListener('click', clickHandler);
    }
};

// ==========================================
// DYNAMIC PREMISE EDIT MODAL
// ==========================================
window.openDynamicEditPremiseModal = (premise) => {
    // Utility to prevent HTML injection characters from breaking the inputs
    const existingModal = document.getElementById('dynamicEditPremiseModal');
    if (existingModal) existingModal.remove();
    
    const safeText = (txt) => txt ? String(txt).replace(/[&<>'"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[m])) : '';

    const modalHtml = `
    <div id="dynamicEditPremiseModal" class="modal-overlay active sub-modal" style="z-index: 99999;">
        <div class="modal-card" style="width: 500px;">
            <div class="modal-header">
                <div>
                    <h2>Edit Premise Details</h2>
                    <h4>Update location and property information</h4>
                </div>
                <button class="modal-close" onclick="document.getElementById('dynamicEditPremiseModal').remove()">✕</button>
            </div>
            <div class="modal-body">
                <form id="dynamicEditPremiseForm">
                    <div class="form-group">
                        <label class="form-label">Premise Name</label>
                        <input type="text" id="edPremName" class="form-input" required value="${safeText(premise.name)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Address</label>
                        <input type="text" id="edPremAddress" class="form-input" required value="${safeText(premise.address)}">
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Floor Area</label>
                            <input type="text" id="edPremFloor" class="form-input" value="${safeText(premise.floor_area)}">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Site Area</label>
                            <input type="text" id="edPremSite" class="form-input" value="${safeText(premise.site_area)}">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Sector</label>
                            <input type="text" id="edPremSector" class="form-input" value="${safeText(premise.sector)}">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Year Built</label>
                            <input type="number" id="edPremYear" class="form-input" value="${premise.year_built || ''}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Legal Description</label>
                        <input type="text" id="edPremLegal" class="form-input" value="${safeText(premise.legal_description)}">
                    </div>
                </form>
            </div>
            <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 12px;">
                <button type="button" class="btn-cancel" onclick="document.getElementById('dynamicEditPremiseModal').remove()">Cancel</button>
                <button type="button" class="btn-access" id="submitEditPremiseBtn" style="width: auto;">Save Changes</button>
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('submitEditPremiseBtn').onclick = async () => {
        const btn = document.getElementById('submitEditPremiseBtn');
        btn.innerText = 'Saving...';
        btn.disabled = true;

        const updateData = {
            name: document.getElementById('edPremName').value.trim(),
            address: document.getElementById('edPremAddress').value.trim(),
            floor_area: document.getElementById('edPremFloor').value.trim() || null,
            site_area: document.getElementById('edPremSite').value.trim() || null,
            sector: document.getElementById('edPremSector').value.trim() || null,
            year_built: parseInt(document.getElementById('edPremYear').value) || null,
            legal_description: document.getElementById('edPremLegal').value.trim() || null
        };

        try {
            const { error } = await supabase.from('premises').update(updateData).eq('id', premise.id);
            if (error) throw error;

            // Apply updates to local memory
            Object.assign(premise, updateData);
            
            // Sync database grids in the background
            if (window.refreshAppAdminData && state.currentUser.role === 'admin') {
                await window.refreshAppAdminData();
            } else if (state.currentUser.role === 'client') {
                await window.fetchAppClientPremises(state.currentUser.id);
            }
            
            document.getElementById('dynamicEditPremiseModal').remove();
            
            // Re-render detail panel with new data
            import('../ui.js').then(ui => ui.showDetail(premise));
            
        } catch (err) {
            alert("Failed to update premise: " + err.message);
            btn.innerText = 'Save Changes';
            btn.disabled = false;
        }
    };
};

// ==========================================
// GLOBAL PASTE LISTENER FOR GALLERY CAROUSEL
// ==========================================
document.addEventListener('paste', async (e) => {
    const detailPanel = document.getElementById('propertyDetailPanel');
    
    // 1. Only trigger if the detail panel is actively open, AND user isn't typing in a search bar
    if (!detailPanel || !detailPanel.classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const items = e.clipboardData?.items;
    if (!items) return;

    let imageFile = null;
    for (let item of items) {
        if (item.type.indexOf('image') !== -1) {
            imageFile = item.getAsFile();
            break;
        }
    }

    if (!imageFile) return; // Ignore if they pasted text/links

    const premise = state.currentViewedPremise;
    if (!premise) return;

    import('../ui.js').then(async (ui) => {
        // 2. We must attach the image to the latest report for this premise
        const { latest } = ui.getPremiseDisplayData(premise);
        if (!latest || !latest.id) {
            alert("Cannot attach image: This property has no reports to link the image to.");
            return;
        }

        const counterEl = document.getElementById('imgCounter');
        const originalText = counterEl.innerText;
        counterEl.innerText = "⏳ Uploading...";

        try {
            // Generate safe file name
            const ext = imageFile.name ? imageFile.name.split('.').pop() : 'png';
            const safeName = `pasted_${Date.now()}.${ext}`;
            const filePath = `${latest.job_number} - ${safeName}`;
            
            // Upload directly to Supabase Storage
            const { error: uploadError } = await supabase.storage.from('GEOMAP-JOB Covers').upload(filePath, imageFile);
            if (uploadError) throw new Error(uploadError.message);

            const newUrl = supabase.storage.from('GEOMAP-JOB Covers').getPublicUrl(filePath).data.publicUrl;

            // Combine with existing images
            let existingImages = [];
            if (latest.image_url) {
                if (Array.isArray(latest.image_url)) existingImages = [...latest.image_url];
                else if (typeof latest.image_url === 'string' && latest.image_url.trim() !== '') {
                    try {
                        existingImages = JSON.parse(latest.image_url);
                        if (!Array.isArray(existingImages)) existingImages = [latest.image_url];
                    } catch(err) { existingImages = latest.image_url.split(',').map(s=>s.trim()); }
                }
            }
            existingImages.push(newUrl);

            // Update Database
            const { error: updateError } = await supabase.from('reports').update({ image_url: existingImages }).eq('id', latest.id);
            if (updateError) throw updateError;

            // Update Local Memory
            latest.image_url = existingImages;
            
            // Refresh UI and jump straight to the newly added image!
            ui.showDetail(premise);
            state.currentGalleryIndex = existingImages.length - 1;
            ui.updateGalleryImage();

        } catch (err) {
            alert("Upload failed: " + err.message);
            counterEl.innerText = originalText;
        }
    });
});

window.triggerStatusUpdate = async (reportId, newStatus, selectElement) => {
    if (!state.currentUser || state.currentUser.role !== 'admin') return;
    
    const safeClass = normalizeStatus(newStatus);
    selectElement.className = `status-select ${safeClass}-status`;
    selectElement.blur();
    
    try {
        const { error } = await supabase.from('reports').update({ status: newStatus }).eq('id', reportId);
        if (error) throw error;
        log(`Status updated to ${newStatus}`);
        
        await window.refreshAppAdminData();
        
        if (state.currentViewedPremise) {
            const updatedPremise = state.premisesData.find(x => String(x.id) === String(state.currentViewedPremise.id));
            if (updatedPremise) showDetail(updatedPremise);
        }
    } catch (err) { 
        log("Update failed: " + err.message, true); 
        alert("Update failed: " + err.message); 
    }
};

window.connectWFM = () => {
    const clientId = 'a1350549-4184-4675-9668-71fcf8f50dcc'; 
    const redirectUri = encodeURIComponent('https://qppsjxvkoihirzicllvg.supabase.co/functions/v1/wfm-callback'); 
    const scope = encodeURIComponent('openid profile email workflowmax offline_access');
    const state = 'bayleys_geomap_auth'; 
    
    const wfmAuthUrl = `https://oauth.workflowmax.com/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&prompt=consent`;
    
    window.location.href = wfmAuthUrl;
};

window.connectXero = () => {
    // You MUST replace "YOUR_XERO_CLIENT_ID" with your actual Client ID string below
    const clientId = '266BB734158F45268C3D85FC9C09F743'; 
    const redirectUri = encodeURIComponent('https://qppsjxvkoihirzicllvg.supabase.co/functions/v1/xero-callback');
    
    // 🌟 THE FIX: Added 'accounting.contacts.read' to the scope string below!
    const scope = encodeURIComponent('openid profile email accounting.invoices.read accounting.contacts.read offline_access');
    
    const xeroAuthUrl = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}`;
    
    window.location.href = xeroAuthUrl;
};

/// app.js - Update this specific section
window.triggerWFMSync = async (btnElement, mode) => {
    if (!mode) return;

    const originalText = btnElement.innerHTML;
    btnElement.disabled = true;

    try {
        let currentPage = 1;
        let hasMore = true;
        let totalProcessed = 0;
        
        // We set a hard limit of 100 for jobs, but let clients sync infinitely
        const limit = mode === 'jobs' ? 100 : Infinity; 

        // Stop the loop if WFM says it's done, OR if we hit our 100 job limit
        while (hasMore && totalProcessed < limit) {
            btnElement.innerHTML = `🔄 Syncing ${mode} (Page ${currentPage})...`;
            
            const { data, error } = await supabase.functions.invoke('wfm-sync', {
                body: { mode: mode, page: currentPage }
            });
            
            if (error) throw error;
            if (data && data.error) throw new Error(data.error);

            totalProcessed += data.count;
            hasMore = data.hasMore;
            
            if (hasMore) {
                currentPage = data.nextPage;
            }
        }
        
        // Cap the success message number so it doesn't look weird if a batch pushed it to 105
        const finalCount = totalProcessed > limit ? limit : totalProcessed;
        
        alert(`Success! Synced the latest ${finalCount} ${mode}.`);
        if (window.refreshAppAdminData) await window.refreshAppAdminData();
        
    } catch (err) {
        console.error("System Error Details:", err);
        alert("System Error: " + (err.message || "Failed to connect to server."));
    } finally {
        btnElement.innerHTML = originalText;
        btnElement.disabled = false;
    }
};

// 3. Core Data Fetching Functions
window.refreshAppAdminData = async () => {
    log("Fetching data...");
    try {
        const { clients, reports, premises, contacts, requests } = await getAdminData();
        state.allReportsData = reports;
        state.premisesData = premises;
        state.contactsData = contacts;
        state.reportRequestsData = requests;
        
        if (state.currentUser && state.currentUser.role === 'admin') {
            // THE FIX: Check device size before deciding to open the widgets "from the get go"
            const isMobile = window.innerWidth <= 900 || document.body.classList.contains('sim-mobile') || document.body.classList.contains('sim-tablet');
            
            import('../ui.js').then(ui => ui.toggleDashboardOverlay(!isMobile));
            
            const activeJobs = reports.filter(job => !['complete','invoice','cancelled'].includes(normalizeStatus(job.status))).length;
            const toInspect = reports.filter(job => normalizeStatus(job.status) === 'new').length;
            
            // --- NEW: Calculate Revenue to Invoice ---
            const invoiceReports = reports.filter(job => ['report','advice'].includes(normalizeStatus(job.status)));
            const invoiceTotal = invoiceReports.reduce((sum, job) => sum + (Number(job.budget) || 0), 0);
            
            // Format as currency (e.g., $15,000)
            const formattedRevenue = '$' + invoiceTotal.toLocaleString('en-NZ', { maximumFractionDigits: 0 });

            document.getElementById('statActive').innerText = activeJobs;
            document.getElementById('statInspect').innerText = toInspect;
            document.getElementById('statInvoice').innerText = formattedRevenue;
            document.getElementById('statPremises').innerText = premises.length;
            
            // This is the clean call to render your charts
            renderBICharts(premises, reports, 'growth');
        }

        state.clientsData = clients.map(client => {
            const clientReports = reports.filter(x => x.client_id === client.id);
            const uniquePremises = new Set(clientReports.map(rep => rep.premise_id));
            const activeCount = clientReports.filter(job => !['complete','invoice','cancelled'].includes(normalizeStatus(job.status))).length;
            
            // --- NEW: Auto-Archive Logic ---
            let isArchived = false;
            // Condition 1: Must have 3 or fewer premises and 0 active jobs
            if (activeCount === 0 && uniquePremises.size <= 3) {
                // Find their most recent activity
                let lastDate = client.created_at ? new Date(client.created_at) : new Date();
                const sortedReps = [...clientReports].sort((a,b) => new Date(b.delivery_date || b.created_at || 0) - new Date(a.delivery_date || a.created_at || 0));
                
                if (sortedReps.length > 0) {
                    lastDate = new Date(sortedReps[0].delivery_date || sortedReps[0].created_at || new Date());
                }
                
                // Condition 2: Must be inactive for more than 6 months (~180 days)
                const inactiveDays = (new Date() - lastDate) / (1000 * 60 * 60 * 24);
                if (inactiveDays > 180) isArchived = true;
            }

            return { ...client, count: uniquePremises.size, active: activeCount, isArchived };
        });
        
        if (state.mapInstance && state.mapInstance.loaded()) addMarkers(state.premisesData);
        else if (state.mapInstance) state.mapInstance.on('load', () => addMarkers(state.premisesData));
        
        filterAdminView();
        log("Data Loaded successfully!");
    } catch(err) {
        log("Fetch Error: " + err.message, true);
    }
};

window.fetchAppClientPremises = async (cid) => {
    log("Fetching client portfolio...");
    try {
        state.premisesData = await getClientPremises(cid);
        if (state.mapInstance && state.mapInstance.loaded()) addMarkers(state.premisesData);
        else if (state.mapInstance) state.mapInstance.on('load', () => addMarkers(state.premisesData));
        log("Portfolio ready.");
    } catch(err) {
        log("Error: " + err.message, true);
    }
};

// 4. Initialization & Event Listeners
window.onload = async () => {
    log("System starting...");
    try {
        // Centers perfectly over New Zealand at a wide zoom
        initMap('loginMapBackground', [174.0, -41.0], 5.5, 0, 0);
        
        // Load the Database Rules & Airports
        import('./api.js').then(async (apiMod) => {
            state.pricingRules = await apiMod.getPricingRules();
            state.estimationMatrix = await apiMod.getEstimationMatrix(); // <-- This was the missing link!
            state.airportsData = await apiMod.getAirports(); 
            state.officesData = await apiMod.getOffices();
            state.discountsData = await apiMod.getDiscounts();
        }).catch(err => console.error("Error loading config data:", err));
        
        // Simple ping to wake up DB
        await supabase.from('clients').select('id', { count: 'exact', head: true });
        log(`System Ready.`);
    } catch(e) { 
        log("DB Error: " + e.message, true); 
    }
};

// --- UPDATED LOGIN EVENT LISTENER ---
document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawInput = document.getElementById('userId').value.trim();
    const pass = document.getElementById('userPassword').value;
    const btn = document.getElementById('loginBtn');
    btn.textContent = "Verifying...";

    try {
        const userId = await loginUser(rawInput, pass);
        // FETCH SECURE ROLE FROM DB
        const userRole = await getUserRole(userId);

        if (userRole === 'admin') {
            state.currentUser = { role: 'admin', name: 'Bayleys Admin', id: userId };
            await window.refreshAppAdminData();
            switchScreen('clientListScreen');
            window.switchAdminTab('clients'); 
        } else {
            const clientData = await getClientById(userId);
            state.currentUser = { role: 'client', ...clientData, id: userId };
            await window.fetchAppClientPremises(userId);
            switchScreen('premisesScreen');
            loadClientView();
        }
    } catch (err) { 
        log("Login Error: " + err.message, true); 
        alert(err.message); 
        btn.textContent = "Login"; 
    }
});

// UI Event Bindings
document.getElementById('adminSearchInput')?.addEventListener('input', (e) => {
    document.getElementById('adminClearSearch').style.display = e.target.value.length > 0 ? 'flex' : 'none';
    filterAdminView();
});
document.getElementById('adminClearSearch')?.addEventListener('click', () => {
    const input = document.getElementById('adminSearchInput');
    input.value = '';
    document.getElementById('adminClearSearch').style.display = 'none';
    filterAdminView();
    input.focus();
});

document.getElementById('clientSearchInput')?.addEventListener('input', (e) => {
    document.getElementById('clientClearSearch').style.display = e.target.value.length > 0 ? 'flex' : 'none';
    loadClientView();
});
document.getElementById('clientClearSearch')?.addEventListener('click', () => {
    const input = document.getElementById('clientSearchInput');
    input.value = '';
    document.getElementById('clientClearSearch').style.display = 'none';
    loadClientView();
    input.focus();
});

// --- Filter Dropdown Toggle ---
document.getElementById('filterToggleBtn')?.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevents the document click listener below from firing immediately
    const btn = e.currentTarget;
    const dropdown = document.getElementById('filterDropdown');
    
    btn.classList.toggle('active');
    dropdown.classList.toggle('active');
});

// Close filter dropdown when clicking outside of it
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('filterDropdown');
    const toggleBtn = document.getElementById('filterToggleBtn');
    
    if (dropdown && dropdown.classList.contains('active')) {
        // If the click is outside both the dropdown and the button, close it
        if (!dropdown.contains(e.target) && !toggleBtn.contains(e.target)) {
            dropdown.classList.remove('active');
            toggleBtn.classList.remove('active');
        }
    }
});

// Detail Panel Gallery Navigation
document.getElementById('nextImgBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.currentGalleryIndex = (state.currentGalleryIndex + 1) % state.currentGalleryImages.length;
    updateGalleryImage();
});

document.getElementById('prevImgBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.currentGalleryIndex = (state.currentGalleryIndex - 1 + state.currentGalleryImages.length) % state.currentGalleryImages.length;
    updateGalleryImage();
});

// NEW: Minimize Panel Toggle
document.getElementById('minimizeDetailBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('propertyDetailPanel').classList.toggle('minimized');
});

document.getElementById('backToAdminBtn')?.addEventListener('click', async () => {
    state.currentUser = { role: 'admin', name: 'Bayleys Admin', id: ADMIN_UUID };
    await window.refreshAppAdminData();
    switchScreen('clientListScreen');
    window.switchAdminTab('clients');
    const searchInput = document.getElementById('adminSearchInput');
    searchInput.value = '';
    document.getElementById('adminClearSearch').style.display = 'none';
});

window.deleteQuoteRequest = async (id, btnElement) => {
    if (!confirm("Are you sure you want to cancel and delete this quote request?\n\nThis will permanently delete the files, remove the database record, and attempt to cancel the lead in WorkflowMax.")) return;

    const originalText = btnElement.innerHTML;
    btnElement.innerHTML = '<span class="spin">🔄</span> Deleting...';
    btnElement.disabled = true;

    try {
        const req = state.reportRequestsData.find(r => String(r.id) === String(id));
        if (!req) throw new Error("Request not found in memory.");

        // 1. Delete associated files (Leases/Plans) from Supabase Storage
        const filesToDelete = [];
        
        // Helper to extract just the folder/filename from the full public URL
        const extractPath = (url) => {
            try {
                const parts = url.split('/report_requests/');
                if (parts.length > 1) return decodeURIComponent(parts[1]);
            } catch(e) {}
            return null;
        };

        if (req.lease_url && Array.isArray(req.lease_url)) {
            req.lease_url.forEach(url => {
                const path = extractPath(url);
                if (path) filesToDelete.push(path);
            });
        }
        if (req.plan_url && Array.isArray(req.plan_url)) {
            req.plan_url.forEach(url => {
                const path = extractPath(url);
                if (path) filesToDelete.push(path);
            });
        }

        if (filesToDelete.length > 0) {
            const { error: storageError } = await supabase.storage.from('report_requests').remove(filesToDelete);
            if (storageError) console.error("Failed to delete files from storage:", storageError);
        }

        // 2. Invoke Edge Function to cancel/delete the WFM lead
        // (Ensure you have an Edge Function named 'wfm-cancel-quote' handling the WFM API deletion)
        try {
            const { error: wfmError } = await supabase.functions.invoke('wfm-cancel-quote', {
                body: { request: req }
            });
            if (wfmError) console.error("WFM Deletion Error:", wfmError);
        } catch (e) {
            console.warn("Could not reach WFM cancellation endpoint", e);
        }

        // 3. Delete the request from the Database AND ask it to return the deleted row
        const { data, error: dbError } = await supabase
            .from('report_requests')
            .delete()
            .eq('id', id)
            .select();
        
        if (dbError) throw dbError;

        // If Supabase returns an empty array, it means RLS silently blocked the command!
        if (!data || data.length === 0) {
            throw new Error("Supabase blocked the deletion! You need to add a 'DELETE' policy to the 'report_requests' table in your Supabase RLS settings.");
        }

        // 4. INSTANTLY wipe it from local memory so the card disappears immediately
        state.reportRequestsData = state.reportRequestsData.filter(r => String(r.id) !== String(id));

        log("Quote request and files deleted successfully.");
        
        // Force the UI to re-render instantly without the deleted card
        import('../ui.js').then(ui => ui.filterAdminView());

        // Run the deep data refresh silently in the background
        window.refreshAppAdminData();

    } catch (err) {
        alert("Failed to delete request: " + err.message);
        btnElement.innerHTML = originalText;
        btnElement.disabled = false;
    }
};

window.generateWFMQuote = async (requestId, event) => {
    const r = state.reportRequestsData.find(req => String(req.id) === String(requestId));
    if (!r) return;

    // 1. Attempt to extract the Target Area to guess the budget
    let sqm = 0;
    const areaMatch = r.notes?.match(/Target Area:\s*([\d,.]+)/i);
    if (areaMatch) sqm = parseFloat(areaMatch[1].replace(/,/g, ''));

    // 2. Look up the Base Cost calculated by the web form
    let suggestedBudget = r.estimated_cost || 3500;
    if (sqm > 0 && state.pricingRules && state.pricingRules.length > 0) {
        let matchingPricing = state.pricingRules.filter(p => p.report_type === r.report_type);
        matchingPricing.sort((a, b) => a.max_sqm - b.max_sqm);
        const tierData = matchingPricing.find(p => sqm <= p.max_sqm);
        
        if (tierData) {
            // Defaulting to the office/retail average for the prompt
            suggestedBudget = tierData.office_fee || tierData.retail_fee || 0; 
            suggestedBudget += 150; // Add the flat travel buffer
        }
    }

    // 3. Prompt the Admin to confirm the Budget amount before sending
    const budgetInput = prompt(
        `Confirm the estimated budget for the ${r.report_type} at ${r.premise_name || r.address}:\n(You can adjust this later in WFM)`, 
        suggestedBudget || 3500
    );
    
    if (budgetInput === null) return; // User clicked Cancel

    const finalBudget = parseFloat(budgetInput.replace(/[^\d.]/g, '')) || 0;

    // 4. UI Loading State
    const btn = event.currentTarget;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spin">🔄</span> Creating Quote...';
    btn.disabled = true;

    try {
        // 5. Send to Supabase Edge Function to securely hit the WFM API
        const { data, error } = await supabase.functions.invoke('wfm-create-quote', {
            body: { 
                request: r,
                budget: finalBudget
            }
        });

        if (error) throw error;
        if (data && data.error) throw new Error(data.error);

        btn.innerHTML = '✓ Quote Created!';
        btn.style.background = '#10b981';
        btn.style.borderColor = '#10b981';

        // 6. Open the newly created quote in a new tab!
        setTimeout(() => {
            btn.innerHTML = originalHtml;
            btn.style.background = '#00264b';
            btn.style.borderColor = '#00264b';
            btn.disabled = false;
            
            // If the API returns the specific quote URL, open it, otherwise open the draft list
            const url = data.quoteUrl || 'https://practicemanager.xero.com/Quote/Draft.aspx';
            window.open(url, '_blank');
        }, 1500);

    } catch (err) {
        alert("Failed to create quote in WFM:\n" + err.message);
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    }
};

// --- SHAREPOINT LIGHTBOX LOGIC ---
document.getElementById('maximizeGalleryBtn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const panel = document.getElementById('propertyDetailPanel');
    const btn = e.currentTarget;
    if (!panel) return;

    const isFullscreen = panel.classList.toggle('fullscreen-gallery');
    
    if (isFullscreen) {
        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"></path></svg>`;

        const p = state.currentViewedPremise;
        const { reports } = getPremiseDisplayData(p); 
        let foundSharePointImages = false;
        let lastErrorMsg = "";

        document.getElementById('imgCounter').innerText = "⌛ Syncing SharePoint...";

        for (const report of reports) {
            if (report.info_url) {
                try {
                    const { data, error } = await supabase.functions.invoke('get-sharepoint-images', {
                        body: { folderUrl: report.info_url }
                    });

                    // Catch Edge Function execution errors
                    if (error) {
                        lastErrorMsg = error.message;
                        console.error(`Edge Error on Job ${report.job_number}:`, error);
                        continue;
                    }

                    // Catch Microsoft Graph API errors returned by the Edge Function
                    if (data && data.error) {
                        lastErrorMsg = data.error;
                        console.error(`Graph Error on Job ${report.job_number}:`, data.error);
                        continue;
                    }

                    // Success! Load images and break the loop
                    if (data && data.images && data.images.length > 0) {
                        state.currentGalleryImages = data.images;
                        state.currentGalleryIndex = 0;
                        updateGalleryImage(); 
                        foundSharePointImages = true;
                        break; 
                    }
                } catch(err) {
                    lastErrorMsg = err.message;
                }
            }
        }

        if (!foundSharePointImages) {
            // Print the error directly to the screen so we aren't guessing
            if (lastErrorMsg) {
                document.getElementById('imgCounter').innerText = "SP Error: " + lastErrorMsg.substring(0, 40) + "...";
            } else {
                document.getElementById('imgCounter').innerText = "No images found in any job folders.";
            }
            
            setTimeout(() => {
                const { images } = getPremiseDisplayData(state.currentViewedPremise);
                state.currentGalleryImages = images.length > 0 ? images : ['https://via.placeholder.com/450x360?text=No+Image'];
                state.currentGalleryIndex = 0;
                updateGalleryImage();
            }, 3500); // Give user time to read the error message
        }

    } else {
        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path></svg>`;
        const { images } = getPremiseDisplayData(state.currentViewedPremise);
        state.currentGalleryImages = images.length > 0 ? images : ['https://via.placeholder.com/450x360?text=No+Image'];
        state.currentGalleryIndex = 0;
        updateGalleryImage();
    }
});

// IMPORTANT: Merged closeDetailBtn logic to ensure it wipes the fullscreen state safely
document.getElementById('closeDetailBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('propertyDetailPanel');
    if (panel) panel.classList.remove('active', 'minimized', 'fullscreen-gallery'); // Clean slate
    state.currentViewedPremise = null;
    
    // Restore sidebar highlights and map zoom
    import('../map.js').then(mapMod => mapMod.highlightMarker(null));
    if (window.highlightSidebarCard) window.highlightSidebarCard(null); 
    
    if (state.mapInstance) state.mapInstance.flyTo({ zoom: 14, pitch: 0 });
    
    if (document.getElementById('clientListScreen').classList.contains('active')) {
        const isMobile = window.innerWidth <= 900 || document.body.classList.contains('sim-mobile') || document.body.classList.contains('sim-tablet');
        toggleDashboardOverlay(!isMobile);
    } else if (document.getElementById('premisesScreen').classList.contains('active')) {
        document.getElementById('requestReportBtn').style.display = 'flex';
    }
});