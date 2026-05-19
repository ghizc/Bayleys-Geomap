// ui.js

import { state } from './store.js';
import { STATUS_OPTIONS, ADMIN_UUID } from './config.js';
import { initMap, addMarkers } from './map.js';
import { supabase } from './api.js'; 

// --- UTILS & LOGGING ---
const logBox = document.getElementById('debugConsole');
let logTimeout;

export function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>'"]/g, match => {
        const escapeMap = { 
            '&': '&amp;', 
            '<': '&lt;', 
            '>': '&gt;', 
            "'": '&#39;', 
            '"': '&quot;' 
        };
        return escapeMap[match];
    });
}

export function log(msg, isError = false) { 
    console.log(msg); 
    logBox.innerText = msg; 
    logBox.className = isError ? 'error' : '';
    logBox.style.opacity = '1';
    logBox.style.transform = 'translateY(0)';
    
    clearTimeout(logTimeout);
    if (!isError) {
        logTimeout = setTimeout(() => { 
            logBox.style.opacity = '0'; 
            logBox.style.transform = 'translateY(10px)'; 
        }, 2500);
    }
}

export const normalizeStatus = (status) => (status || '').toString().toLowerCase().trim();

// --- UI DASHBOARD FUNCTIONS ---
export function toggleDashboardOverlay(show) {
    const dash = document.getElementById('adminDashboardWidgets');
    if (dash && state.currentUser && state.currentUser.role === 'admin') {
        if (show) {
            dash.style.display = 'flex';
            setTimeout(() => dash.classList.remove('hidden'), 10);
        } else {
            dash.classList.add('hidden');
            setTimeout(() => { if (dash.classList.contains('hidden')) dash.style.display = 'none'; }, 300);
        }
    }
}

export function renderBICharts(premises, reports, type = 'growth') {
    const ctx = document.getElementById('biChart');
    if (!ctx) return;

    // 1. Calculate Average Turnaround Time
    const currentYear = new Date().getFullYear();
    const reportsThisYear = reports.filter(r => r.delivery_date && r.inspection_date && new Date(r.delivery_date).getFullYear() === currentYear);
    
    let avgTurnaround = '-';
    if (reportsThisYear.length > 0) {
        const totalDays = reportsThisYear.reduce((sum, r) => sum + Math.max(0, Math.ceil((new Date(r.delivery_date) - new Date(r.inspection_date)) / (1000 * 60 * 60 * 24))), 0);
        avgTurnaround = Math.round(totalDays / reportsThisYear.length) + ' Days';
    }
    
    const kpiEl = document.getElementById('kpiTurnaround');
    if (kpiEl) kpiEl.innerHTML = `${currentYear} Avg Turnaround: <span>${avgTurnaround}</span>`;

    if (window.biChartInstance instanceof Chart) window.biChartInstance.destroy();
    const canvasContext = ctx.getContext('2d');

    // Global Chart Formatting for Material UI Feel
    Chart.defaults.font.family = "'Segoe UI', 'Roboto', sans-serif";
    Chart.defaults.color = '#64748b';
    const chartPadding = { left: 10, right: 10, top: 10, bottom: 10 };

    // --- 1. REVENUE (NZ Financial Year Logic) ---
    if (type === 'revenue') {
        const fyTotals = {};
        
        // Helper: NZ FY starts April 1 (Month index 3)
        const getNZFY = (dateStr) => {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return null;
            return d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();
        };

        reports.forEach(r => {
            if (normalizeStatus(r.status) === 'cancelled') return;
            const budget = Number(r.budget) || 0;
            if (budget <= 0) return;

            const dateStr = r.delivery_date || r.inspection_date || r.created_at;
            const fy = getNZFY(dateStr);
            if (fy) fyTotals[fy] = (fyTotals[fy] || 0) + budget;
        });

        // Determine Current, Last, and Best FY
        const now = new Date();
        const currentFY = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
        const lastFY = currentFY - 1;

        let bestFY = null;
        let bestRev = -1;
        Object.keys(fyTotals).forEach(fyStr => {
            const fy = parseInt(fyStr);
            if (fy !== currentFY && fy !== lastFY && fyTotals[fy] > bestRev) {
                bestRev = fyTotals[fy];
                bestFY = fy;
            }
        });

        // Fallback if there is no older history
        if (!bestFY) bestFY = lastFY - 1; 

        const revenueData = {
            [`Current FY${currentFY.toString().slice(-2)}`]: fyTotals[currentFY] || 0,
            [`Last FY${lastFY.toString().slice(-2)}`]: fyTotals[lastFY] || 0,
            [`Best (FY${bestFY.toString().slice(-2)})`]: fyTotals[bestFY] || 0
        };

        window.biChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: Object.keys(revenueData),
                datasets: [{
                    data: Object.values(revenueData),
                    // Material Colors: Primary Blue, Slate Grey, Amber
                    backgroundColor: ['#1976D2', '#94a3b8', '#FBC02D'],
                    borderRadius: 4,
                    maxBarThickness: 60
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, layout: { padding: chartPadding },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (c) => '$' + c.raw.toLocaleString('en-NZ') } }
                },
                scales: {
                    x: { grid: { display: false } },
                    y: { beginAtZero: true, border: {display:false}, ticks: { callback: (v) => '$' + (v / 1000) + 'k' } }
                }
            }
        });

    } 
    // --- 2. GROWTH ---
    else if (type === 'growth') {
        const months = [], premiseCounts = [], reportCounts = [];
        const premiseFirstContact = {}; 
        reports.forEach(r => {
            const date = r.inspection_date ? new Date(r.inspection_date) : (r.delivery_date ? new Date(r.delivery_date) : new Date(r.created_at));
            if (!premiseFirstContact[r.premise_id] || date < premiseFirstContact[r.premise_id]) premiseFirstContact[r.premise_id] = date;
        });

        for (let i = 5; i >= 0; i--) {
            const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
            months.push(d.toLocaleString('default', { month: 'short', year: '2-digit' }));
            reportCounts.push(reports.filter(r => {
                const targetDate = r.inspection_date ? new Date(r.inspection_date) : (r.delivery_date ? new Date(r.delivery_date) : new Date(r.created_at));
                return targetDate.getMonth() === d.getMonth() && targetDate.getFullYear() === d.getFullYear();
            }).length);
            premiseCounts.push(Object.values(premiseFirstContact).filter(firstDate => firstDate.getMonth() === d.getMonth() && firstDate.getFullYear() === d.getFullYear()).length);
        }

        const gradBlue = canvasContext.createLinearGradient(0, 0, 0, 200);
        gradBlue.addColorStop(0, 'rgba(25, 118, 210, 0.2)'); gradBlue.addColorStop(1, 'rgba(25, 118, 210, 0.0)');
        const gradGreen = canvasContext.createLinearGradient(0, 0, 0, 200);
        gradGreen.addColorStop(0, 'rgba(56, 142, 60, 0.2)'); gradGreen.addColorStop(1, 'rgba(56, 142, 60, 0.0)');

        window.biChartInstance = new Chart(ctx, {
            type: 'line',
            data: { labels: months, datasets: [
                { label: 'Reports', data: reportCounts, borderColor: '#1976D2', backgroundColor: gradBlue, borderWidth: 3, fill: true, tension: 0.4, pointRadius: 4 },
                { label: 'Premises', data: premiseCounts, borderColor: '#388E3C', backgroundColor: gradGreen, borderWidth: 3, fill: true, tension: 0.4, pointRadius: 4 }
            ]},
            options: { responsive: true, maintainAspectRatio: false, layout: { padding: chartPadding }, plugins: { legend: { position: 'top', labels: {usePointStyle: true, boxWidth: 8} } }, scales: { x: {grid: {display: false}}, y: {beginAtZero: true, border: {display:false}} } }
        });

    } 
    // --- 3. SECTORS (Strict Blank Removal) ---
    else if (type === 'sector') {
        const sectorCounts = {};
        premises.forEach(p => { 
            const s = (p.sector || '').trim();
            // 🌟 THE FIX: If the sector is completely blank, we STOP and ignore it entirely!
            if (!s || s === '') return; 
            sectorCounts[s] = (sectorCounts[s] || 0) + 1; 
        });
        
        // Material UI Palette
        const materialColors = ['#1976D2', '#388E3C', '#FBC02D', '#D32F2F', '#7B1FA2', '#0097A7', '#F57C00', '#C2185B'];

        window.biChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: { labels: Object.keys(sectorCounts), datasets: [{ data: Object.values(sectorCounts), backgroundColor: materialColors, borderWidth: 2, borderColor: '#fff' }] },
            options: { responsive: true, maintainAspectRatio: false, layout: { padding: chartPadding }, cutout: '70%', plugins: { legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8, font: {size: 11} } } } }
        });

    } 
    // --- 4. WORKLOAD (Strict Inclusion List) ---
    else if (type === 'workload') {
        const surveyors = {};
        
        // 🌟 THE FIX: ONLY look at jobs explicitly in the active phases
        const activeReports = reports.filter(r => ['new', 'inspection', 'report', 'advice'].includes(normalizeStatus(r.status)));
        
        activeReports.forEach(r => {
            const s = (r.surveyed_by || '').trim();
            // 🌟 THE FIX: If no surveyor is assigned, ignore it completely so "Unassigned" doesn't skew the chart!
            if (!s || s === '') return; 
            surveyors[s] = (surveyors[s] || 0) + 1;
        });

        // Sort Highest to Lowest
        const sortedSurveyors = Object.fromEntries(Object.entries(surveyors).sort(([,a], [,b]) => b - a));

        window.biChartInstance = new Chart(ctx, {
            type: 'bar',
            data: { labels: Object.keys(sortedSurveyors), datasets: [{ label: 'Active Jobs', data: Object.values(sortedSurveyors), backgroundColor: '#0097A7', borderRadius: 4, maxBarThickness: 30 }] },
            options: { responsive: true, maintainAspectRatio: false, layout: { padding: chartPadding }, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } }, y: {grid: {display: false}} } }
        });

    } 
    // --- 5. JOB AGING (Strict Active Only) ---
    else if (type === 'aging') {
        const aging = {'0-7 Days': 0, '8-14 Days': 0, '15-30 Days': 0, '30+ Days': 0};
        const now = new Date();
        
        // 🌟 THE FIX: Only age jobs that are actively in the pipeline
        reports.filter(r => ['new', 'inspection', 'report', 'advice'].includes(normalizeStatus(r.status))).forEach(r => {
            const start = r.inspection_date ? new Date(r.inspection_date) : new Date(r.created_at || now);
            const days = Math.floor((now - start) / (1000 * 60 * 60 * 24));
            
            if (days <= 7) aging['0-7 Days']++; 
            else if (days <= 14) aging['8-14 Days']++; 
            else if (days <= 30) aging['15-30 Days']++; 
            else aging['30+ Days']++;
        });

        window.biChartInstance = new Chart(ctx, {
            type: 'bar',
            data: { labels: Object.keys(aging), datasets: [{ label: 'Active Jobs', data: Object.values(aging), backgroundColor: ['#388E3C', '#FBC02D', '#F57C00', '#D32F2F'], borderRadius: 4, maxBarThickness: 50 }] },
            options: { responsive: true, maintainAspectRatio: false, layout: { padding: chartPadding }, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: {grid: {display: false}} } }
        });
    }
}

export function renderFilterDropdown(type) {
    const dropdown = document.getElementById('filterDropdown');
    
    let options = [];
    if (type === 'clients') {
        options = [
            { val: 'all', label: 'All Clients' }, { val: 'active', label: 'Active Clients' }, 
            { val: 'inactive', label: 'Inactive Clients' }, { val: 'archived', label: 'Archived Clients' } 
        ];
    } else if (type === 'contacts') {
        options = [{ val: 'all', label: 'All Contacts' }];
    } else if (type === 'quotes') {
        options = [
            { val: 'all', label: 'All Requests' }, { val: 'pending', label: 'Pending' }, 
            { val: 'approved', label: 'Approved' }, { val: 'cancelled', label: 'Cancelled' }
        ];
    } else {
        options = [{ val: 'all', label: 'All Job Statuses' }, ...STATUS_OPTIONS.map(o => ({ val: o.toLowerCase(), label: o }))];
    }

    dropdown.innerHTML = options.map(opt => `
        <div class="filter-option ${opt.val === state.currentAdminSubFilter ? 'selected' : ''}" data-val="${opt.val}">
            ${opt.label}
        </div>
    `).join('');

    dropdown.querySelectorAll('.filter-option').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            state.currentAdminSubFilter = el.dataset.val;
            renderFilterDropdown(type);
            document.getElementById('filterDropdown').classList.remove('active');
            document.getElementById('filterToggleBtn').classList.remove('active');
            filterAdminView();
        });
    });
}

export function getPremiseDisplayData(premise) {
    const reports = premise.reports ? premise.reports : state.allReportsData.filter(r => String(r.premise_id) === String(premise.id));
    
    // Sort from newest job to oldest job based on job number
    const sortedReports = [...reports].sort((a, b) => {
        const jobA = parseInt(String(a.job_number).replace(/\D/g, '')) || 0;
        const jobB = parseInt(String(b.job_number).replace(/\D/g, '')) || 0;
        return jobB - jobA; 
    });

    let jobImages = [];

    // Loop through the sorted reports, starting with the newest
    for (const report of sortedReports) {
        if (report.image_url) {
            let parsedImages = [];
            try {
                const parsed = Array.isArray(report.image_url) ? report.image_url : JSON.parse(report.image_url);
                if (Array.isArray(parsed)) parsedImages.push(...parsed);
            } catch(e) {
                parsedImages.push(...report.image_url.split(',').map(s => s.trim()));
            }
            
            // If this job actually has images, save them and STOP searching older jobs
            if (parsedImages.length > 0) {
                jobImages = parsedImages;
                break; 
            }
        }
    }

    return { 
        reports: sortedReports,
        latest: sortedReports.length > 0 ? sortedReports[0] : {},
        status: sortedReports.length > 0 ? (sortedReports[0].status || 'Complete') : 'Complete',
        images: jobImages, // Now only contains images from the latest valid job
        displayImage: jobImages.length > 0 ? jobImages[0] : null
    };
}

export function filterAdminView() {
    const type = state.activeAdminTab;
    const list = document.getElementById('clientList');
    const query = (document.getElementById('adminSearchInput').value || '').toLowerCase().trim();
    const subFilterVal = state.currentAdminSubFilter;

    if (type === 'clients') {
        let filtered = state.clientsData;
        
        if (subFilterVal === 'all') filtered = filtered.filter(c => !c.isArchived);
        else if (subFilterVal === 'active') filtered = filtered.filter(c => c.active > 0 && !c.isArchived);
        else if (subFilterVal === 'inactive') filtered = filtered.filter(c => c.active === 0 && !c.isArchived);
        else if (subFilterVal === 'archived') filtered = filtered.filter(c => c.isArchived);

        if (query) filtered = filtered.filter(c => c.name.toLowerCase().includes(query));
        
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        
        if (filtered.length === 0) return list.innerHTML = `<div style="text-align:center; padding: 40px 20px; color: #94a3b8; font-size: 13px; font-weight: 500;">No clients found matching criteria.</div>`;

        list.innerHTML = filtered.map(c => {
            // --- DESKTOP Logic ---
            let inactiveDisplay = '';
            if (c.active === 0) {
                const clientReps = state.allReportsData.filter(r => r.client_id === c.id && r.delivery_date);
                if (clientReps.length > 0) {
                    clientReps.sort((a,b) => new Date(b.delivery_date) - new Date(a.delivery_date));
                    const diffDays = Math.floor((new Date() - new Date(clientReps[0].delivery_date)) / (1000 * 60 * 60 * 24));
                    
                    if (diffDays < 0) inactiveDisplay = `0 days inactive`;
                    else if (diffDays < 7) inactiveDisplay = `${diffDays} days inactive`;
                    else if (diffDays < 30) inactiveDisplay = `${Math.floor(diffDays/7)} wks inactive`;
                    else if (diffDays < 365) inactiveDisplay = `${Math.floor(diffDays/30)} mos inactive`;
                    else inactiveDisplay = `${Math.floor(diffDays/365)} yrs inactive`;
                } else {
                    inactiveDisplay = "No prior reports";
                }
            }

            const badgeHtml = c.isArchived
                ? `<span style="color: #64748b; font-weight: 600;">ARCHIVED</span>`
                : (c.active > 0 ? `<span style="color: #00264b; font-weight: 600;">${c.active} Active Jobs</span>` : `<span style="color: #f43f5e; font-weight: 600;">${inactiveDisplay}</span>`);

            const clientVip = window.getClientVipTier ? window.getClientVipTier(c.id) : { revenue: 0 };
            const formattedRevenue = `$${clientVip.revenue.toLocaleString()}`;

            let parts = [];
            if (c.group) parts.push(`<span style="color: #0284c7; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">${c.group}</span>`);
            
            let actualUrl = '#';
            if (c.website) {
                const displayUrl = c.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
                actualUrl = c.website.startsWith('http') ? c.website : `https://${c.website}`;
                parts.push(`<span style="display: inline-flex; align-items: center; gap: 4px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"></path></svg><a href="${actualUrl}" target="_blank" onclick="event.stopPropagation();" style="color: #64748b; text-decoration: none; transition: 0.2s;" onmouseover="this.style.color='#0284c7'" onmouseout="this.style.color='#64748b'">${displayUrl}</a></span>`);
            }
            parts.push(`<span style="font-weight: 500; color: #64748b;">${formattedRevenue}</span>`);
            const subRow = `<div style="font-size: 11px; margin-bottom: 14px; display: flex; align-items: center; justify-content: center; gap: 8px;">${parts.join(' <span style="color: #cbd5e1; font-size: 12px;">•</span> ')}</div>`;

            // --- MOBILE Logic ---
            const dotColor = c.isArchived ? '#94a3b8' : (c.active > 0 ? '#10b981' : '#ef4444');
            
            const editBtn = (state.currentUser && state.currentUser.role === 'admin') 
                ? `<button onclick="event.stopPropagation(); window.openEditClientModal(${JSON.stringify(c).replace(/"/g, '&quot;')})" style="position: absolute; top: 16px; left: 16px; background: transparent; border: none; color: #94a3b8; cursor: pointer; transition: 0.2s; z-index: 10;" onmouseover="this.style.color='#0284c7'" onmouseout="this.style.color='#94a3b8'" title="Edit Client"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>` 
                : '';

            let mobileTitleHtml = '';
            if (c.website) {
                mobileTitleHtml = `
                    <a href="${actualUrl}" target="_blank" onclick="event.stopPropagation();" style="font-weight: 600; font-size: 18px; color: #0f172a; text-decoration: none; display: flex; align-items: center; gap: 6px;">
                        ${c.name}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.5" style="margin-top: 2px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                    </a>`;
            } else {
                mobileTitleHtml = `<div style="font-weight: 600; font-size: 18px; color: #0f172a;">${c.name}</div>`;
            }

            return `
            <div class="card-item client-card" onclick="window.triggerClientLoad('${c.id}')" style="position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 28px 20px;">
                
                ${editBtn}
                
                <div class="mobile-layout-dot" style="display: none; position: absolute; top: 16px; right: 16px; width: 12px; height: 12px; border-radius: 50%; background-color: ${dotColor}; box-shadow: 0 0 0 2px white, 0 2px 6px rgba(0,0,0,0.15);"></div>

                <img src="${c.logo_url || 'https://via.placeholder.com/200x60?text=No+Logo'}" alt="${c.name} Logo" onerror="this.src='https://via.placeholder.com/200x60?text=No+Logo'" style="height: 55px; width: auto; max-width: 240px; object-fit: contain; margin-bottom: 18px;" class="card-logo-img">
                
                <div class="desktop-layout" style="width: 100%;">
                    <div class="client-card-title" style="font-weight: 600; font-size: 18px; color: #0f172a; margin-bottom: 8px;">${c.name}</div>
                    ${subRow}
                    <div class="client-card-meta" style="font-size: 12px; color: #64748b; font-weight: 500; background: #f8fafc; padding: 6px 16px; border-radius: 20px; border: 1px solid #e2e8f0; display: inline-block;">
                        ${c.count} Premises &nbsp;•&nbsp; ${badgeHtml}
                    </div>
                </div>

                <div class="mobile-layout" style="display: none; width: 100%; flex-direction: column; align-items: center; gap: 8px;">
                    ${mobileTitleHtml}
                    <div style="display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%;">
                        <div style="display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; color: #475569; background: #f8fafc; padding: 6px 12px; border-radius: 20px; border: 1px solid #e2e8f0;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect><path d="M9 22v-4h6v4"></path><path d="M8 6h.01"></path><path d="M16 6h.01"></path><path d="M12 6h.01"></path><path d="M12 10h.01"></path><path d="M12 14h.01"></path><path d="M16 10h.01"></path><path d="M16 14h.01"></path><path d="M8 10h.01"></path><path d="M8 14h.01"></path></svg>
                            ${c.count}
                        </div>
                        <div style="font-weight: 700; color: #0284c7; font-size: 13px; background: #f0f9ff; padding: 6px 12px; border-radius: 20px; border: 1px solid #bae6fd; display: flex; align-items: center;">
                            ${formattedRevenue}
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');

    } else if (type === 'contacts') {
        let filtered = state.contactsData;
        filtered = filtered.map(c => {
            const client = state.clientsData.find(cl => cl.id === c.client_id);
            return { ...c, client_name: client ? client.name : 'Unknown Company' };
        });

        if (query) {
            filtered = filtered.filter(c => 
                `${c.first_name} ${c.last_name}`.toLowerCase().includes(query) || 
                (c.client_name).toLowerCase().includes(query)
            );
        }
        filtered.sort((a, b) => (a.first_name || '').localeCompare(b.first_name || ''));
        if (filtered.length === 0) return list.innerHTML = `<div style="text-align:center; padding: 40px 20px; color: #94a3b8; font-size: 13px; font-weight: 500;">No contacts found matching criteria.</div>`;

        list.innerHTML = filtered.map(c => {
            const fullName = `${c.first_name || ''} ${c.last_name || ''}`.trim();
            const position = c.position ? `<div style="font-size: 11px; color: #0284c7; font-weight: 700; text-transform: uppercase; margin-top: 4px; letter-spacing: 0.5px;">${c.position}</div>` : '';
            const email = c.email ? `<div style="margin-top: 8px; font-size: 12px; color: #475569; display: flex; align-items: flex-start; gap: 8px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" style="flex-shrink: 0; margin-top: 2px;"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg> <a href="mailto:${c.email}" style="color: #475569; text-decoration: none; font-weight: 500; word-break: break-all;">${c.email}</a></div>` : '';
            const phone = c.mobile ? `<div style="margin-top: 6px; font-size: 12px; color: #475569; display: flex; align-items: center; gap: 8px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> <a href="tel:${c.mobile}" style="color: #475569; text-decoration: none; font-weight: 500;">${c.mobile}</a></div>` : '';
            const linkedin = c.linkedin ? `<div style="margin-top: 6px; font-size: 12px; display: flex; align-items: center; gap: 8px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0a66c2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"></path><rect x="2" y="9" width="4" height="12"></rect><circle cx="4" cy="4" r="2"></circle></svg> <a href="${c.linkedin}" target="_blank" style="color: #0a66c2; text-decoration: none; font-weight: 500; transition: 0.2s;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">LinkedIn Profile</a></div>` : '';
            const initials = `${(c.first_name?.[0]||'')}${(c.last_name?.[0]||'')}`.toUpperCase();
            const profilePic = c.profile_image_url 
                ? `<img src="${c.profile_image_url}" style="width: 56px; height: 56px; border-radius: 50%; object-fit: cover; border: 2px solid #e2e8f0; flex-shrink: 0; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">` 
                : `<div style="width: 56px; height: 56px; border-radius: 50%; background: #f8fafc; color: #94a3b8; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 18px; border: 2px solid #e2e8f0; flex-shrink: 0;">${initials}</div>`;
            const editBtn = (state.currentUser && state.currentUser.role === 'admin') 
                ? `<button onclick="window.openEditContactModal('${c.id}')" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; cursor: pointer; color: #94a3b8; transition: 0.2s;" onmouseover="this.style.color='#0284c7'" onmouseout="this.style.color='#94a3b8'" title="Edit Contact"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>` : '';

            return `
            <div class="card-item" style="position: relative; cursor: default; display: flex; gap: 16px; align-items: flex-start;">
                ${editBtn} ${profilePic}
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 700; font-size: 16px; color: #0f172a; padding-right: 24px;">${fullName}</div>
                    <div style="font-size: 12px; color: #64748b; font-weight: 500; margin-top: 2px;">@ ${c.client_name}</div>
                    ${position}
                    <div style="margin-top: 14px; border-top: 1px dashed #e2e8f0; padding-top: 10px;">${email}${phone}${linkedin}</div>
                </div>
            </div>`;
        }).join('');

    } else if (type === 'quotes') {
        let filtered = state.reportRequestsData;
        if (subFilterVal !== 'all') filtered = filtered.filter(r => (r.status || 'Pending').toLowerCase() === subFilterVal);
        if (query) filtered = filtered.filter(r => (r.client_name || '').toLowerCase().includes(query) || (r.address || '').toLowerCase().includes(query) || (r.report_type || '').toLowerCase().includes(query));

        if (filtered.length === 0) return list.innerHTML = `<div style="text-align:center; padding: 40px 20px; color: #94a3b8; font-size: 13px; font-weight: 500;">No quote requests found.</div>`;

        list.innerHTML = filtered.map(r => {
            let statusStr = r.status || 'Pending';
            
            // --- AUTO-DETECT CONVERTED JOBS ---
            if (statusStr.toLowerCase() === 'pending') {
                const clientMatch = state.clientsData.find(c => (c.name || '').toLowerCase() === (r.client_name || '').toLowerCase());
                
                if (clientMatch) {
                    const isNowAJob = state.allReportsData.find(job => {
                        // 1. MUST be an active job (New or Inspection)
                        const safeStatus = (job.status || '').toString().toLowerCase().trim();
                        if (safeStatus !== 'new' && safeStatus !== 'inspection') return false;

                        // 2. Check if it belongs to the same client
                        if (job.client_id !== clientMatch.id) return false;
                        
                        // 3. Check if it's the exact same report type (e.g., PCR)
                        if ((job.report_type || '').toLowerCase() !== (r.report_type || '').toLowerCase()) return false;
                        
                        // 4. Check if the Report Name matches
                        const jobName = (job.name || '').toLowerCase().trim();
                        const reqName = (r.premise_name || '').toLowerCase().trim();
                        const nameMatch = jobName && reqName && (jobName.includes(reqName) || reqName.includes(jobName));
                        
                        // 5. Check if the Street Address matches
                        let addressMatch = false;
                        const p = state.premisesData.find(prem => prem.id === job.premise_id);
                        if (p) {
                            const pAddr = (p.address || '').toLowerCase();
                            const rAddr = (r.address || '').toLowerCase();
                            
                            // Split by comma to isolate the Street Name
                            const pStreet = pAddr.split(',')[0].trim();
                            const rStreet = rAddr.split(',')[0].trim();
                            
                            addressMatch = pStreet && rStreet && (pStreet.includes(rStreet) || rStreet.includes(pStreet));
                        }
                        
                        // Return TRUE if either the Name OR the Address is a match!
                        return addressMatch || nameMatch;
                    });

                    // If a matching job exists in the system, override the badge text!
                    if (isNowAJob) statusStr = 'Job Active';
                }
            }

            const safeClass = statusStr.toLowerCase();
            let badgeClass = 'new-status'; 
            
            // Make the badge green if it's active
            if (safeClass === 'approved' || safeClass === 'job active') badgeClass = 'complete-status'; 
            if (safeClass === 'cancelled') badgeClass = 'invoice-status'; 

            let attachHtml = '';
            if (r.lease_url && r.lease_url.length > 0) attachHtml += `<a href="${r.lease_url[0]}" target="_blank" style="color: #0284c7; text-decoration: none; font-size: 11px; font-weight: 700; margin-right: 12px; transition: 0.2s;" onmouseover="this.style.color='#0369a1'" onmouseout="this.style.color='#0284c7'">📄 Leases</a>`;
            if (r.plan_url && r.plan_url.length > 0) attachHtml += `<a href="${r.plan_url[0]}" target="_blank" style="color: #0284c7; text-decoration: none; font-size: 11px; font-weight: 700; transition: 0.2s;" onmouseover="this.style.color='#0369a1'" onmouseout="this.style.color='#0284c7'">📐 Plans</a>`;

            return `
            <div class="card-item" style="cursor: default;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2px;">
                    <div style="font-weight: 700; font-size: 15px; color: #0f172a;">${r.client_name}</div>
                    <div class="status-pill ${badgeClass}" style="position: static; font-size: 9px; padding: 4px 10px;">${statusStr}</div>
                </div>
                <div style="font-size: 11px; color: #64748b; font-weight: 500; margin-bottom: 10px;">Requested by: <span style="color: #0f172a; font-weight: 600;">${r.property_manager || 'Unknown'}</span></div>
                <div style="font-size: 13px; color: #0f172a; font-weight: 600; margin-bottom: 4px;">🏢 ${r.premise_name || 'New Location'}</div>
                <div style="font-size: 12px; color: #64748b; font-weight: 500; margin-bottom: 6px;">📍 ${r.address}</div>
                <div style="font-size: 12px; color: #0284c7; font-weight: 600; margin-bottom: 12px;">📋 ${r.report_type} &nbsp;•&nbsp; <span style="color: #64748b; font-weight: 500;">Due: ${r.delivery_deadline}</span></div>
                ${r.notes ? `<div style="background: #f8fafc; padding: 12px; border-radius: 8px; font-size: 11px; color: #475569; margin-bottom: 12px; border: 1px solid #e2e8f0; line-height: 1.4;"><strong>Notes:</strong> ${r.notes}</div>` : ''}
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed #e2e8f0; padding-top: 12px;">
                    <div>${attachHtml || '<span style="font-size: 11px; color: #94a3b8; font-weight: 500;">No attachments</span>'}</div>
                    <div style="display: flex; justify-content: flex-end; gap: 8px;">
                        <button onclick="window.deleteQuoteRequest('${r.id}', this)" style="padding: 6px 14px; font-size: 11px; border: 1px solid #fca5a5; background: #fef2f2; color: #ef4444; border-radius: 6px; cursor: pointer; font-weight: 700; transition: 0.2s;" onmouseover="this.style.background='#fee2e2'" onmouseout="this.style.background='#fef2f2'">Cancel & Delete</button>
                    </div>
                </div>
            </div>`;
        }).join('');

    } else if (type === 'reports') {
        let filtered = state.allReportsData;
        
        if (query) {
            filtered = filtered.filter(r => {
                // Find the associated premise for this report
                const p = state.premisesData.find(prem => prem.id === r.premise_id) || {};
                
                const rName = (r.name || '').toLowerCase();
                const pName = (p.name || '').toLowerCase();
                const pAddr = (p.address || '').toLowerCase();
                const jNum = String(r.job_number).toLowerCase();
                const rType = (r.report_type || '').toLowerCase();

                // Return true if the search query is found in ANY of these fields
                return jNum.includes(query) || 
                       rType.includes(query) || 
                       rName.includes(query) || 
                       pName.includes(query) || 
                       pAddr.includes(query);
            });
        }
        
        if (subFilterVal !== 'all') filtered = filtered.filter(r => normalizeStatus(r.status) === subFilterVal);
        
        const statusOrder = { 'new': 1, 'inspection': 2, 'report': 3, 'advice': 4, 'invoice': 5, 'cancelled': 6, 'complete': 7 };
        filtered.sort((a, b) => (statusOrder[normalizeStatus(a.status)] || 99) - (statusOrder[normalizeStatus(b.status)] || 99) || (Number(b.job_number) || 0) - (Number(a.job_number) || 0));

        if (filtered.length === 0) return list.innerHTML = `<div style="text-align:center; padding: 40px 20px; color: #94a3b8; font-size: 13px; font-weight: 500;">No reports found matching criteria.</div>`;

        list.innerHTML = filtered.map(r => {
            const safeClass = normalizeStatus(r.status);
            let displayName = r.name || 'Unlinked Report';
            if (r.premise_id) {
                const p = state.premisesData.find(p => p.id === r.premise_id);
                if (p) displayName = p.name || displayName;
            }
            return `
            <div class="card-item report-card-admin" onclick="window.triggerDetailLoad('${r.premise_id}')">
                <div style="display:flex; align-items: flex-start; gap: 14px;">
                    <div class="report-card-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 4px;">
                            <div>
                                <div style="font-weight:700; font-size:14px; color:#0f172a; letter-spacing:-0.2px;">Job #${r.job_number}</div>
                                <div style="font-weight:600; font-size:11px; color:#0284c7; margin-top:2px;">${r.report_type} Report</div>
                            </div>
                            <div class="status-pill ${safeClass}-status" style="position:static; margin-left: 8px;">${r.status}</div>
                        </div>
                        <div style="font-size:11px; color:#64748b; display:flex; align-items:flex-start; gap:4px; margin-top: 6px; line-height: 1.3;">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
                            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${displayName}</span>
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }
}

export function loadClientView() {
    const displayClient = state.currentUser.clientSpoof || state.currentUser;
    document.getElementById('brandLogo').src = displayClient.logo_url || '';
    document.getElementById('userNameDisplay').innerText = displayClient.name;
    document.getElementById('userAvatar').innerText = displayClient.name.substring(0, 2).toUpperCase();
    
    if (state.currentUser.role === 'client') document.getElementById('backToAdminBtn').style.display = 'none';
    
    const query = (document.getElementById('clientSearchInput').value || '').toLowerCase().trim();
    const list = document.getElementById('premisesList');
    
    let filtered = [...state.premisesData];
    
    if (query) {
        filtered = filtered.filter(p => {
            const pName = (p.name || '').toLowerCase();
            const pAddr = (p.address || '').toLowerCase();
            const pSec = (p.sector || '').toLowerCase();
            
            // Look through this premise's reports to see if any report names match the search
            const pReports = p.reports || state.allReportsData.filter(r => String(r.premise_id) === String(p.id));
            const hasMatchingReport = pReports.some(r => (r.name || '').toLowerCase().includes(query));

            return pName.includes(query) || 
                   pAddr.includes(query) || 
                   pSec.includes(query) || 
                   hasMatchingReport;
        });
    }

    const statusOrder = { 'new': 1, 'inspection': 2, 'report': 3, 'advice': 4, 'invoice': 5, 'cancelled': 6, 'complete': 7 };
    filtered.sort((a, b) => (statusOrder[normalizeStatus(getPremiseDisplayData(a).status)] || 99) - (statusOrder[normalizeStatus(getPremiseDisplayData(b).status)] || 99) || (a.name || '').localeCompare(b.name || ''));

    if(filtered.length === 0) return list.innerHTML = `<div style="text-align:center; padding: 40px 20px; color: #94a3b8; font-size: 13px; font-weight: 500;">No premises found matching "${query}"</div>`;

    list.innerHTML = filtered.map(p => {
        const { displayImage, status } = getPremiseDisplayData(p);
        const safeClass = normalizeStatus(status);
        return `<div class="card-item premise-card" onclick="window.triggerDetailLoad('${p.id}')">
            <div class="premise-card-image"><img src="${displayImage || 'https://via.placeholder.com/400x300?text=No+Image'}"><div class="status-pill ${safeClass}-status">${status}</div></div>
            <div class="card-title">${p.name}</div><div class="card-meta">${p.floor_area} &nbsp;•&nbsp; ${p.sector}</div>
        </div>`;
    }).join('');
}

export function showDetail(p) {
    state.currentViewedPremise = p; 
    toggleDashboardOverlay(false);
    
    const reqBtn = document.getElementById('requestReportBtn');
    if (reqBtn) reqBtn.style.display = 'none';

    const detailPanel = document.getElementById('propertyDetailPanel');
    const mainContent = document.querySelector('.screen.active .main-content');
    
    if (mainContent) {
        const mapContainer = document.getElementById('premisesMap');
        if (mapContainer && mainContent.contains(mapContainer)) {
            mainContent.insertBefore(detailPanel, mapContainer);
        } else {
            mainContent.appendChild(detailPanel);
        }
        
        setTimeout(() => {
            mainContent.scrollTo({ left: 0, behavior: 'instant' });
        }, 10);
    }

    // --- FIX: DIRECT MOBILE "DETAILS" BUTTON ---
    const mapDiv = document.getElementById('premisesMap');
    if (mapDiv && !document.getElementById('mobileMapControls')) {
        const btn = document.createElement('button');
        btn.id = 'mobileMapControls'; 
        btn.className = 'mobile-only'; 
        btn.style.cssText = 'position: absolute; top: 16px; left: 16px; padding: 10px 16px; background: #00264b; color: white; border: none; border-radius: 20px; font-weight: 700; font-size: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); z-index: 1000; align-items: center; gap: 6px; cursor: pointer; transition: 0.2s;';
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg> Details`;
        
        // UPGRADED TO SCROLL INTO VIEW
        btn.onclick = () => {
            const panel = document.getElementById('propertyDetailPanel');
            if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
        };
        mapDiv.appendChild(btn);
    }

    if (!window.recenterMap) {
        window.recenterMap = () => {
            const curP = state.currentViewedPremise;
            if (curP && state.mapInstance && curP.lat) {
                // Focus on the specific premise
                state.mapInstance.flyTo({ center: [curP.lng, curP.lat], range: 200, pitch: 45 });
            } else if (state.currentUser?.role === 'client' && state.mapInstance && state.premisesData.length > 0) {
                // 🌟 Bonus: If no premise is selected, zoom out to show the whole portfolio!
                let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
                let validPins = 0;
                state.premisesData.forEach(p => {
                    if (p.lat && p.lng) {
                        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
                        minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
                        validPins++;
                    }
                });
                if (validPins > 0) {
                    const cLat = (minLat + maxLat) / 2;
                    const cLng = (minLng + maxLng) / 2;
                    const maxDiff = Math.max(maxLat - minLat, maxLng - minLng);
                    
                    let cZoom = 4.0;
                    if (validPins === 1) cZoom = 15.5;
                    else if (maxDiff < 0.02) cZoom = 12.5;
                    else if (maxDiff < 0.1) cZoom = 10.5;
                    else if (maxDiff < 0.5) cZoom = 8.5;
                    else if (maxDiff < 2) cZoom = 6.5;
                    else if (maxDiff < 10) cZoom = 5.0;
                    else if (maxDiff < 30) cZoom = 4.0;
                    else cZoom = 3.0;
                    
                    state.mapInstance.flyTo({ center: [cLng, cLat], zoom: cZoom, pitch: 0, bearing: 0 });
                }
            }
        };
    }

    const { reports, latest, images, status } = getPremiseDisplayData(p);
    detailPanel.classList.add('active');
    
    state.currentGalleryImages = images.length > 0 ? images : ['https://via.placeholder.com/450x360?text=No+Image'];
    state.currentGalleryIndex = 0;
    updateGalleryImage();

    // 1. Fill Property Stats
    document.getElementById('detailTitle').innerText = p.name;
    document.getElementById('detailAddress').innerText = p.address;
    document.getElementById('detailFloor').innerText = p.floor_area || '-';
    document.getElementById('detailSite').innerText = p.site_area || '-';
    document.getElementById('detailSector').innerText = p.sector || '-';
    document.getElementById('detailAge').innerText = p.year_built ? `${new Date().getFullYear() - p.year_built} Years` : '-';
    document.getElementById('detailSurveyor').innerText = latest.surveyed_by || '-';
    document.getElementById('detailInspected').innerText = latest.inspection_date || '-';
    document.getElementById('detailDelivery').innerText = latest.delivery_date || '-';
    document.getElementById('detailLegal').innerText = p.legal_description || '-'; 

    document.getElementById('videoBtn').style.display = latest.video_url ? 'flex' : 'none';
    document.getElementById('videoBtn').onclick = () => window.open(latest.video_url, '_blank');
    document.getElementById('btnEnrichData').style.display = (state.currentUser && state.currentUser.role === 'admin') ? 'block' : 'none';
    
    const btnEnrich = document.getElementById('btnEnrichData');
    if (btnEnrich) {
        btnEnrich.style.display = (state.currentUser && state.currentUser.role === 'admin') ? 'flex' : 'none';
        btnEnrich.className = 'icon-btn';
        btnEnrich.title = "Auto-Enrich Data";
        // Strip inline styles from HTML so it perfectly matches the icon-btn class
        btnEnrich.style.background = '';
        btnEnrich.style.color = '';
        btnEnrich.style.border = '';
        btnEnrich.style.width = '';
        btnEnrich.style.height = '';
        btnEnrich.style.padding = '';
        btnEnrich.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`;
    }

    let btnViewMap = document.getElementById('btnViewMapMobile');
    if (!btnViewMap) {
        btnViewMap = document.createElement('button');
        btnViewMap.id = 'btnViewMapMobile';
        btnViewMap.className = 'icon-btn mobile-only'; 
        btnViewMap.title = "View Map";
        btnViewMap.style.marginRight = '8px'; 
        btnViewMap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>`;
        
        btnViewMap.onclick = () => {
            const mapEl = document.getElementById('premisesMap');
            if (mapEl) mapEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
        };
        if (btnEnrich && btnEnrich.parentNode) btnEnrich.parentNode.insertBefore(btnViewMap, btnEnrich);
    }

    let btnMovePin = document.getElementById('btnMovePin');
    if (!btnMovePin) {
        btnMovePin = document.createElement('button');
        btnMovePin.id = 'btnMovePin';
        btnMovePin.title = "Correct Map Pin Location";
        btnMovePin.className = 'icon-btn';
        btnMovePin.style.marginRight = '8px';
        btnMovePin.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="22" y1="12" x2="18" y2="12"></line><line x1="6" y1="12" x2="2" y2="12"></line><line x1="12" y1="6" x2="12" y2="2"></line><line x1="12" y1="22" x2="12" y2="18"></line></svg>`;
        
        if (btnEnrich && btnEnrich.parentNode) btnEnrich.parentNode.insertBefore(btnMovePin, btnEnrich);
    }

    btnMovePin.onclick = () => {
        if (window.enablePinMoveMode) window.enablePinMoveMode(p);
    };

    let btnEditPremise = document.getElementById('btnEditPremise');
    if (!btnEditPremise) {
        btnEditPremise = document.createElement('button');
        btnEditPremise.id = 'btnEditPremise';
        btnEditPremise.title = "Edit Premise Details";
        btnEditPremise.className = 'icon-btn';
        btnEditPremise.style.marginRight = '8px';
        btnEditPremise.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
        
        if (btnEnrich && btnEnrich.parentNode) btnEnrich.parentNode.insertBefore(btnEditPremise, btnEnrich);
    }

    btnEditPremise.onclick = () => {
        if (window.openDynamicEditPremiseModal) window.openDynamicEditPremiseModal(p);
    };
    
    // 2. Render Reports Table
    const isAdmin = state.currentUser && state.currentUser.role === 'admin';
    const header = document.getElementById('reportsTableHeader');
    const body = document.getElementById('reportsTableBody');

    if (header && body) {
        header.innerHTML = `<tr>
            <th>Property</th><th>Type</th><th>Job #</th><th>Status</th>
            <th style="text-align:center;">PDF</th><th style="text-align:center;">INFO</th><th style="text-align:center;">INV</th>${isAdmin ? '<th style="text-align:center;">EDIT</th>' : ''}
        </tr>`;
        
        body.innerHTML = reports.map(r => {
            const pdfIcon = r.pdf_url ? `<a href="${r.pdf_url}" target="_blank" class="icon-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></a>` : '-';
            const infoIcon = r.info_url ? `<a href="${r.info_url}" target="_blank" class="icon-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></a>` : '-';
            const invIcon = r.invoice_url ? `<a href="${r.invoice_url}" target="_blank" class="icon-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></a>` : '-';
            const editIcon = isAdmin ? `<button type="button" onclick="window.openEditReportModal('${r.id}')" class="icon-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>` : '';
            
            const safeClass = normalizeStatus(r.status);
            const statusHtml = isAdmin
                ? `<select onchange="window.triggerStatusUpdate('${r.id}', this.value, this)" class="status-select ${safeClass}-status">
                    ${STATUS_OPTIONS.map(opt => `<option value="${opt}" ${safeClass === opt.toLowerCase() ? 'selected' : ''}>${opt}</option>`).join('')}
                   </select>`
                : `<span class="status-pill ${safeClass}-status">${r.status}</span>`;
            
            return `<tr>
                <td style="max-width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${r.name || p.name}</td>
                <td>${r.report_type || '-'}</td>
                <td>${r.job_number}</td>
                <td>${statusHtml}</td>
                <td style="text-align:center;">${pdfIcon}</td>
                <td style="text-align:center;">${infoIcon}</td>
                <td style="text-align:center;">${invIcon}</td>
                ${isAdmin ? `<td style="text-align:center;">${editIcon}</td>` : ''}
            </tr>`;
        }).join('');
    }

    if (state.mapInstance && p.lat) {
        state.mapInstance.flyTo({ center: [p.lng, p.lat], range: 200, pitch: 45 });
    }
}

document.getElementById('btnEnrichData').onclick = async () => {
    const premise = state.currentViewedPremise;
    if (!premise) return;

    const url = prompt(`Paste OneRoof URL for ${premise.name}:`);
    if (!url) return;

    const btn = document.getElementById('btnEnrichData');
    // Keep it an SVG icon instead of text
    const originalHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`;
    
    // Use the minimal spinner
    btn.innerHTML = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    btn.disabled = true;

    try {
        const { data, error } = await supabase.functions.invoke('enrich-premise', {
            body: { premise_id: premise.id, oneroof_url: url }
        });

        if (error || (data && data.error)) throw new Error(error?.message || data?.error);

        const res = data.data;

        const formatArea = (val) => {
            if (!val || val === '-') return '-';
            let clean = val.toString().replace(/[^\d.]/g, ''); 
            let num = parseFloat(clean);
            if (isNaN(num)) return val;
            return num.toLocaleString() + ' m²'; 
        };

        document.getElementById('detailTitle').innerText = res.name || '-';
        document.getElementById('detailAddress').innerText = res.address || '-';
        document.getElementById('detailFloor').innerText = formatArea(res.floor_area);
        document.getElementById('detailSite').innerText = formatArea(res.site_area);
        document.getElementById('detailSector').innerText = res.sector || '-';
        document.getElementById('detailLegal').innerText = res.legal_description || '-';
                
        if (res.year_built) {
            document.getElementById('detailAge').innerText = `${new Date().getFullYear() - parseInt(res.year_built)} Years`;
        }

        if (window.refreshAppAdminData) await window.refreshAppAdminData();

    } catch (err) {
        alert("System Error: " + err.message);
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        // Notice we removed the green background color reset so it stays uniform!
    }
};

export function updateGalleryImage() {
    document.getElementById('detailImg').src = state.currentGalleryImages[state.currentGalleryIndex];
    document.getElementById('imgCounter').innerText = `${state.currentGalleryIndex + 1} / ${state.currentGalleryImages.length}`;
    const showNav = state.currentGalleryImages.length > 1;
    document.getElementById('prevImgBtn').style.display = showNav ? 'flex' : 'none';
    document.getElementById('nextImgBtn').style.display = showNav ? 'flex' : 'none';
}

export function switchScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    const isDetailOpen = document.getElementById('propertyDetailPanel')?.classList.contains('active');
    document.getElementById('requestReportBtn').style.display = (id === 'premisesScreen' && !isDetailOpen) ? 'flex' : 'none';    
    
    requestAnimationFrame(() => {
        // 🌟 THE FIX 1: Make this setTimeout callback 'async'
        setTimeout(async () => {
            const mapContainer = id === 'clientListScreen' ? 'adminMap' : 'premisesMap';
            if (document.getElementById(mapContainer)) {
                
                let startLng = 174.7554;
                let startLat = -36.8454;
                let startZoom = 15.5;

                if (id === 'premisesScreen' && state.currentUser?.role === 'client') {
                    if (state.premisesData && state.premisesData.length > 0) {
                        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
                        let validPins = 0;
                        
                        state.premisesData.forEach(p => {
                            if (p.lat && p.lng) {
                                minLat = Math.min(minLat, p.lat);
                                maxLat = Math.max(maxLat, p.lat);
                                minLng = Math.min(minLng, p.lng);
                                maxLng = Math.max(maxLng, p.lng);
                                validPins++;
                            }
                        });

                        if (validPins > 0) {
                            startLat = (minLat + maxLat) / 2;
                            startLng = (minLng + maxLng) / 2;
                            const maxDiff = Math.max(maxLat - minLat, maxLng - minLng);
                            
                            if (validPins === 1) startZoom = 15.5;
                            else if (maxDiff < 0.02) startZoom = 12.5; 
                            else if (maxDiff < 0.1) startZoom = 10.5;  
                            else if (maxDiff < 0.5) startZoom = 8.5;   
                            else if (maxDiff < 2) startZoom = 6.5;     
                            else if (maxDiff < 10) startZoom = 5.0;    
                            else if (maxDiff < 30) startZoom = 4.0;    
                            else startZoom = 3.0;                      
                        }
                    }
                }

                // 🌟 THE FIX 2: Add 'await' so the script pauses here until the map is 100% fully rendered
                await initMap(mapContainer, [startLng, startLat], startZoom, 60, -17.6);
                
                // 🌟 THE FIX 3: Now that the map is guaranteed to exist, we can safely drop the markers immediately
                if (state.premisesData.length > 0) {
                    addMarkers(state.premisesData);
                }
            }
        }, 100);
    });
}
