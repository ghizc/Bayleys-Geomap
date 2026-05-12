// service-worker.js

self.addEventListener('install', (event) => {
    // Forces the waiting service worker to become the active service worker.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Tells the active service worker to take control of the page immediately.
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // A simple pass-through network fetch. 
    // If the network fails (offline), it just gracefully fails rather than breaking your Supabase connection.
    event.respondWith(
        fetch(event.request).catch((error) => {
            console.log('Network request failed, user might be offline.', error);
        })
    );
});