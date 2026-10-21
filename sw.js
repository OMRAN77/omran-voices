// Lets the phone install the site as an app. Nothing is cached: the voices
// always come fresh from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
