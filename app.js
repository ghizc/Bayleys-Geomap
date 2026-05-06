// app.js

// 1. Imports
import { state } from './store.js';
import { ADMIN_UUID } from './config.js';
import { supabase, loginUser, getAdminData, getClientPremises, getClientById, getUserRole } from './api.js';
import { initMap, addMarkers, highlightMarker } from './map.js';
import { 
    log, toggleDashboardOverlay, renderBICharts, filterAdminView, 
    loadClientView, showDetail, updateGalleryImage, switchScreen, 
    renderFilterDropdown, normalizeStatus, getPremiseDisplayData 
} from './ui.js';
import './modals.js'; // Running this executes the modal setup code

// 2. Global Hooks for Inline HTML Event Handlers

window.switchChart = (type, btnElement) => {
    // Handle UI button active state
    document.querySelectorAll('.chart-tab').forEach(el => el.classList.remove('active'));
    btnElement.classList.add('active');
    
    // Render the new chart using the ui.js function
    import('./ui.js').then(ui => {
        ui.renderBICharts(state.premisesData, state.allReportsData, type);
    });
};

window.filterDashboard = (filterType, cardElement) => {
    // 1. Highlight the clicked card
    document.querySelectorAll('.stat-card').forEach(el => el.classList.remove('active-filter'));
    cardElement.classList.add('active-filter');

    // 2. Filter map markers and left sidebar list based on KPI clicked
    import('./ui.js').then(ui => {
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
        import('./map.js').then(mapMod => {
            mapMod.addMarkers(filteredPremises);
        });

        // 4. Update Sidebar
        ui.filterAdminView(); 
    });
};

// --- CLEAN HIGH-SPEED XERO MAPPING ---
let localDbClients = [];
let localXeroContacts = [];

const cleanForMatch = (str) => {
    return (str || "").toLowerCase()
        .replace(/\b(ltd|limited|trust|partners|co|group|nz|new zealand|bayleys)\b/g, "")
        .replace(/[^a-z0-9]/g, "")
        .trim();
};

window.openXeroMapping = async () => {
    const modal = document.getElementById('xeroMappingModal');
    const loading = document.getElementById('mappingLoading');
    const content = document.getElementById('mappingContent');
    
    modal.style.display = 'flex';
    loading.style.display = 'block';
    content.style.display = 'none';

    try {
        // 1. Fetch Data
        const { data: dbClients } = await supabase.from('clients')
            .select('id, name, xero_contact_id')
            .is('xero_contact_id', null)
            .order('name');
        
        const { data: xeroData } = await supabase.functions.invoke('xero-get-contacts');
        
        localDbClients = dbClients || [];
        localXeroContacts = xeroData?.contacts || [];

        // Safety check: if no contacts come back, warn immediately
        if (localXeroContacts.length === 0) {
            loading.innerHTML = `<div style="padding:20px; color:#ef4444; font-weight:bold;">⚠️ Error: Zero contacts received from Xero.<br><small>Please click 'Connect Xero' on the map menu again to authorize access.</small></div>`;
            return;
        }

        // 2. Build the Clean UI Shell (No Search Bar)
        content.innerHTML = `
            <div style="padding: 12px 24px; border-bottom: 1px solid #f1f5f9; display: flex; justify-content: space-between; align-items: center; background: #f8fafc;">
                <div style="font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
                    Clients to Link: <span id="remainingCount" style="color: #0ea5e9; font-size: 14px;">${localDbClients.length}</span>
                </div>
                <div style="font-size: 10px; color: #10b981; font-weight: 700; display: flex; align-items: center; gap: 4px; text-transform: uppercase;">
                    <span style="font-size: 14px;">✨</span> Auto-Matcher Active
                </div>
            </div>
            <div style="max-height: 550px; overflow-y: auto;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tbody id="mappingTableBody"></tbody>
                </table>
            </div>
        `;

        const renderRows = () => {
            const tbody = document.getElementById('mappingTableBody');
            
            // Build the static Xero options list once for performance
            const xeroOptionsHtml = localXeroContacts.map(xc => `<option value="${xc.id}">${xc.name}</option>`).join('');

            // Show 20 clients at a time for a clean, fast list
            const batch = localDbClients.slice(0, 20);

            tbody.innerHTML = batch.map(client => {
                const cNameClean = cleanForMatch(client.name);
                
                // Logic: Does this client have a "Good" suggestion in Xero?
                const hasMatch = localXeroContacts.some(xc => {
                    const xcClean = cleanForMatch(xc.name);
                    return (xcClean.length > 2 && (xcClean.includes(cNameClean) || cNameClean.includes(xcClean)));
                });

                return `
                <tr id="row-${client.id}" style="border-bottom: 1px solid #f1f5f9; background: ${hasMatch ? '#f0fdfa' : 'white'}; transition: 0.3s;">
                    <td style="padding: 20px; width: 35%; vertical-align: top;">
                        <div style="font-weight: 700; color: #0f172a; font-size: 14px; line-height: 1.2;">${client.name}</div>
                        ${hasMatch ? `<div style="font-size: 9px; color: #0ea5e9; font-weight: 800; text-transform: uppercase; margin-top: 6px; letter-spacing: 0.5px;">Suggestion Ready</div>` : ''}
                    </td>
                    <td style="padding: 12px 10px;">
                        <select id="select-${client.id}" multiple class="xero-select-box" style="width: 100%; height: 90px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; padding: 4px; background: white;">
                            ${xeroOptionsHtml}
                        </select>
                    </td>
                    <td style="padding: 20px; width: 110px; text-align: right; vertical-align: middle;">
                        <button onclick="window.saveXeroLink('${client.id}')" 
                            style="background: ${hasMatch ? '#0ea5e9' : '#10b981'}; color: white; border: none; padding: 12px 18px; border-radius: 8px; cursor: pointer; font-weight: 800; font-size: 11px; white-space: nowrap; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                            ${hasMatch ? 'CONFIRM' : 'LINK'}
                        </button>
                    </td>
                </tr>`;
            }).join('');

            // After rendering the HTML, programmatically highlight the matched items in the select boxes
            batch.forEach(client => {
                const cNameClean = cleanForMatch(client.name);
                const matchedIds = localXeroContacts
                    .filter(xc => {
                        const xcClean = cleanForMatch(xc.name);
                        return (xcClean.length > 2 && (xcClean.includes(cNameClean) || cNameClean.includes(xcClean)));
                    })
                    .map(xc => xc.id);

                const select = document.getElementById(`select-${client.id}`);
                if (select) {
                    Array.from(select.options).forEach(opt => {
                        if (matchedIds.includes(opt.value)) opt.selected = true;
                    });
                }
            });
        };

        renderRows();
        loading.style.display = 'none';
        content.style.display = 'block';

    } catch (err) {
        loading.innerHTML = `<div style="padding:20px; color:#ef4444;">Error: ${err.message}</div>`;
    }
};

window.saveXeroLink = async (clientId) => {
    const selectEl = document.getElementById(`select-${clientId}`);
    const selectedIds = Array.from(selectEl.selectedOptions).map(opt => opt.value);
    
    if (selectedIds.length === 0) return alert("Select at least one Xero contact.");

    const btn = selectEl.parentElement.nextElementSibling.querySelector('button');
    btn.innerText = "⌛";
    btn.disabled = true;

    try {
        const { error } = await supabase.from('clients')
            .update({ xero_contact_id: selectedIds.join(',') })
            .eq('id', clientId);

        if (error) throw error;

        // Success animation
        const row = document.getElementById(`row-${clientId}`);
        row.style.background = '#f0fdf4';
        row.style.opacity = '0';
        row.style.transform = 'scale(0.98)';
        
        localDbClients = localDbClients.filter(c => c.id !== clientId);
        
        setTimeout(() => {
            row.remove();
            const countEl = document.getElementById('remainingCount');
            if (countEl) countEl.innerText = localDbClients.length;
            
            // If the visible list is almost empty, refresh to pull the next 20 unmapped clients
            const currentListCount = document.getElementById('mappingTableBody').children.length;
            if (currentListCount < 5 && localDbClients.length > 0) {
                window.openXeroMapping(); 
            }
        }, 300);

    } catch (err) {
        alert("Failed to save: " + err.message);
        btn.innerText = "LINK";
        btn.disabled = false;
    }
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
        import('./map.js').then(mapMod => mapMod.highlightMarker(p.id));
        
        // Pass the reportId if we clicked a report, otherwise fallback to the premiseId
        window.highlightSidebarCard(reportId || p.id);
        
        // Pass the reportId into the UI so it can feature the correct data!
        showDetail(p, reportId);
    }
};

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
            
            import('./ui.js').then(ui => ui.toggleDashboardOverlay(!isMobile));
            
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

window.updateQuoteStatus = async (id, newStatus) => {
    try {
        const { error } = await supabase.from('report_requests').update({ status: newStatus }).eq('id', id);
        if (error) throw error;
        
        log(`Quote marked as ${newStatus}`);
        await window.refreshAppAdminData(); // Refresh the list instantly
    } catch (err) {
        alert("Failed to update status: " + err.message);
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
    import('./map.js').then(mapMod => mapMod.highlightMarker(null));
    if (window.highlightSidebarCard) window.highlightSidebarCard(null); 
    
    if (state.mapInstance) state.mapInstance.flyTo({ zoom: 14, pitch: 0 });
    
    if (document.getElementById('clientListScreen').classList.contains('active')) {
        const isMobile = window.innerWidth <= 900 || document.body.classList.contains('sim-mobile') || document.body.classList.contains('sim-tablet');
        toggleDashboardOverlay(!isMobile);
    } else if (document.getElementById('premisesScreen').classList.contains('active')) {
        document.getElementById('requestReportBtn').style.display = 'flex';
    }
});
