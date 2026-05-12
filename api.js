// api.js

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Authenticates a user
 */
export async function loginUser(rawUserId, password) {
    const fakeEmail = `${rawUserId}@bayleys.co.nz`; 
    const { data, error } = await supabase.auth.signInWithPassword({ 
        email: fakeEmail, 
        password: password 
    });
    
    if (error) throw new Error("Incorrect Username or Password");
    return data.user.id;
}

/**
 * Fetches core data for Admin (Bypasses 1000 row limits)
 */
export async function getAdminData() {
    // Fetch Clients & Contacts normally (usually smaller tables)
    const clientsRes = await supabase.from('clients').select('*');
    if (clientsRes.error) throw clientsRes.error;

    const contactsRes = await supabase.from('contacts').select('*');
    if (contactsRes.error) throw contactsRes.error;

    const requestsRes = await supabase.from('report_requests').select('*').order('request_date', { ascending: false });
    if (requestsRes.error) throw requestsRes.error;

    // Fetch ALL Reports using a pagination loop
    let allReports = [];
    let rFetchMore = true;
    let rFrom = 0;
    while (rFetchMore) {
        const { data, error } = await supabase.from('reports')
            .select('*')
            .order('created_at', { ascending: false })
            .range(rFrom, rFrom + 999);
            
        if (error) throw error;
        if (data && data.length > 0) {
            allReports.push(...data);
            rFrom += 1000;
        }
        if (!data || data.length <= 999) rFetchMore = false;
    }

    // Fetch ALL Premises using a pagination loop
    let allPremises = [];
    let pFetchMore = true;
    let pFrom = 0;
    while (pFetchMore) {
        const { data, error } = await supabase.from('premises')
            .select('*')
            .order('created_at', { ascending: false })
            .range(pFrom, pFrom + 999);
            
        if (error) throw error;
        if (data && data.length > 0) {
            allPremises.push(...data);
            pFrom += 1000;
        }
        if (!data || data.length <= 999) pFetchMore = false;
    }

    return {
        clients: clientsRes.data || [],
        reports: allReports,
        premises: allPremises,
        contacts: contactsRes.data || [],
        requests: requestsRes.data || []
    };
}

/**
 * Fetches premises for a specific client
 */
export async function getClientPremises(clientId) {
    // 1. Fetch any report where the user is the Primary OR Shared client
    const { data: reports, error: rErr } = await supabase
        .from('reports')
        .select('*')
        .or(`client_id.eq.${clientId},shared_clients.cs.{${clientId}}`);
        
    if (rErr) throw rErr;
    if (!reports || reports.length === 0) return [];

    // 2. Extract unique Premise IDs from those reports
    const premiseIds = [...new Set(reports.map(r => r.premise_id))];

    // 3. Fetch the Premises
    const { data: premises, error: pErr } = await supabase
        .from('premises')
        .select('*')
        .in('id', premiseIds);

    if (pErr) throw pErr;

    // 4. Bind the reports into the premises so the UI works exactly as before
    return premises.map(p => ({
        ...p,
        reports: reports.filter(r => r.premise_id === p.id)
    }));
}

/**
 * Fetches specific client data by ID
 */
export async function getClientById(clientId) {
    const { data, error } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
    
    if (error) throw error;
    if (!data) throw new Error("No client profile found for this user account.");
    
    return data;
}

/**
 * Uploads multiple files to a Supabase bucket
 */
export async function uploadMultipleFiles(fileInput, bucketName, folderName = '', prefix = '') {
    if (!fileInput.files || fileInput.files.length === 0) return null;
    const uploadedUrls = [];
    
    for (const file of fileInput.files) {
        const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        let filePath = folderName ? `${folderName}/` : '';
        filePath += `${prefix}${Date.now()}_${safeName}`;
        
        const { error } = await supabase.storage.from(bucketName).upload(filePath, file);
        if (error) throw new Error(`Failed to upload ${file.name}: ${error.message}`);
        
        const { data } = supabase.storage.from(bucketName).getPublicUrl(filePath);
        uploadedUrls.push(data.publicUrl);
    }
    return uploadedUrls;
}

/**
 * Fetches the global pricing rules engine
 */
export async function getPricingRules() {
    const { data, error } = await supabase.from('pricing_rules').select('*');
    if (error) throw error;
    return data || [];
}

export async function getAirports() {
    const { data, error } = await supabase.from('nz_airports').select('*');
    if (error) throw error;
    return data || [];
}

export async function getOffices() {
    const { data, error } = await supabase.from('offices').select('*');
    if (error) throw error;
    return data || [];
}

export async function getDiscounts() {
    // Order descending so highest revenue tier is first
    const { data, error } = await supabase.from('discounts').select('*').eq('is_active', true).order('min_revenue', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function getEstimationMatrix() {
    const { data, error } = await supabase.from('estimation_matrix').select('*');
    
    // If Supabase outright rejects the connection
    if (error) {
        alert("SUPABASE CONNECTION ERROR: " + error.message);
        console.error("Matrix Error:", error);
        throw error;
    }
    
    // If Supabase connects, but hands back zero rows
    if (!data || data.length === 0) {
        alert("SUPABASE WARNING: The app connected to 'estimation_matrix', but it returned ZERO rows. \n\nEither the table is completely empty, or Row Level Security (RLS) is hiding the rows from the public.");
    }
    
    return data || [];
}

/**
 * Fetches the user role securely
 */
export async function getUserRole(userId) {
    const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle();
    
    if (error || !data) return 'client'; 
    return data.role;
}

// ==========================================
// SMART PWA INSTALLATION LOGIC
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
    const installPrompt = document.getElementById('pwaInstallPrompt');
    const installBtn = document.getElementById('pwaInstallBtn');
    const installText = document.getElementById('pwaInstallText');
    let deferredPrompt = null;

    // 1. Check if the app is already installed/running in standalone mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone || document.referrer.includes('android-app://');
    if (isStandalone) {
        return; // They already have the app, do nothing.
    }

    // 2. Detect Apple/iOS Devices
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (isIOS) {
        // Apple forces manual installation. We show them how.
        installText.innerHTML = `Tap the <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align: middle; margin: 0 2px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg> <b>Share</b> button below, then select <br><b>"Add to Home Screen"</b>.`;
        
        // Only show this once per session so it doesn't annoy them
        if (!sessionStorage.getItem('iosPromptShown')) {
            setTimeout(() => {
                if (installPrompt) installPrompt.style.display = 'flex';
                sessionStorage.setItem('iosPromptShown', 'true');
            }, 2000); // Wait 2 seconds after page loads
        }
    }

    // 3. Detect Android/Chrome Devices (Catch the native install event)
    window.addEventListener('beforeinstallprompt', (e) => {
        // Prevent Chrome's default mini-infobar from appearing
        e.preventDefault();
        // Stash the event so it can be triggered later.
        deferredPrompt = e;
        
        // Update UI to show our custom Install button
        if (installPrompt) installPrompt.style.display = 'flex';
        if (installBtn) installBtn.style.display = 'block';

        if (installBtn) {
            installBtn.addEventListener('click', async () => {
                // Hide the custom banner
                installPrompt.style.display = 'none';
                // Show the native Android install prompt
                deferredPrompt.prompt();
                // Wait for the user to respond to the prompt
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') {
                    console.log('User accepted the PWA prompt');
                }
                deferredPrompt = null;
            });
        }
    });
});