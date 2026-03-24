/**
 * V2 Edge Proxy - Service Worker
 * Intercepts dynamic fetches and patches JS/HTML on the fly.
 */

self.addEventListener('install', (event) => {
    // Force the waiting service worker to become the active service worker.
    self.skipWaiting();
    console.log("🛡️ V2 Proxy SW - Installed");
});

self.addEventListener('activate', (event) => {
    // Claim any clients immediately so we don't have to wait for a reload
    event.waitUntil(clients.claim());
    console.log("🛡️ V2 Proxy SW - Activated & Claimed Clients");
});

// --- THE REGEX PIPELINE ---
// Copied from ProxyInterceptor so the SW can run it independently
function applyRegexPipeline(rawText) {
    if (!rawText || typeof rawText !== 'string') return rawText;
    return rawText
        .replace(/\bwindow\.location\b/g, 'window.__proxyLocation')
        .replace(/\bdocument\.location\b/g, 'document.__proxyLocation')
        .replace(/\btop\.location\b/g, 'top.__proxyLocation')
        .replace(/(?<![a-zA-Z0-9_$])(?<!\.)\blocation\b(?=\s*(?:\.|\[|===?|!==?|=(?!=)))/g, 'window.__proxyLocation');
}

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // 1. Bail out early for non-GET requests (we don't rewrite POST bodies here)
    if (req.method !== 'GET') return;

    // 2. Identify resource type via destination
    const isDocument = req.destination === 'document' || req.destination === 'iframe';
    const isScript = req.destination === 'script' || req.destination === 'worker' || req.destination === 'sharedworker';

    // 3. Fallback check using Accept headers (for XHR/Fetch calls)
    const accept = req.headers.get('Accept') || '';
    const expectsHtmlOrJs = accept.includes('text/html') || accept.includes('javascript');

    // If it's an image, CSS, font, or video, let the browser handle it natively
    if (!isDocument && !isScript && !expectsHtmlOrJs) {
        return; // Proceeds with normal network request
    }

    event.respondWith((async () => {
        try {
            // Fetch the actual resource
            const response = await fetch(req);

            // Don't touch redirects, errors, or opaque (CORS-blocked) responses
            if (!response.ok || response.type === 'opaque') return response;

            // Final safety check: ensure the server actually returned HTML/JS
            const contentType = response.headers.get('Content-Type') || '';
            const isHtmlOrJsResponse = contentType.includes('text/html') || contentType.includes('javascript');

            if (!isHtmlOrJsResponse) {
                return response;
            }

            // Read the raw text from the response
            let text = await response.text();

            // Patch the text on the fly!
            text = applyRegexPipeline(text);

            // Reconstruct the response with the patched payload
            const newHeaders = new Headers(response.headers);
            
            // CRITICAL: We changed the length of the string, so we MUST delete Content-Length
            // Otherwise, the browser will truncate the file or throw a network error.
            newHeaders.delete('Content-Length');
            
            // Rewrite CSP instead of completely stripping it to maintain security
            const csp = newHeaders.get('Content-Security-Policy');
            if (csp) {
                // Extract the base proxy domain (e.g., "hash.proxy.com" -> "proxy.com")
                const hostnameParts = self.location.hostname.split('.');
                hostnameParts.shift(); // Remove the current hash subdomain
                const baseProxyDomain = hostnameParts.join('.');
                
                // Allow wildcard proxy subdomains, inline scripts for our interceptor, and blob for the SW
                const allowedSources = `'unsafe-inline' 'unsafe-eval' https://*.${baseProxyDomain} ${self.location.origin} blob: data:`;

                const patchedCsp = csp.split(';').map(directive => {
                    const trimmedDirective = directive.trim();
                    const directiveName = trimmedDirective.split(/\s+/)[0];
                    
                    // Directives that need to allow our proxy ecosystem
                    const targets = [
                        'default-src', 'script-src', 'script-src-elem', 
                        'connect-src', 'worker-src', 'frame-src', 
                        'img-src', 'style-src', 'font-src', 'media-src'
                    ];
                    
                    if (targets.includes(directiveName)) {
                        return `${trimmedDirective} ${allowedSources}`;
                    }
                    return trimmedDirective;
                }).join('; ');
                
                newHeaders.set('Content-Security-Policy', patchedCsp);
            }

            return new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders
            });

        } catch (err) {
            console.warn("🛡️ V2 Proxy SW - Fetch interception failed, falling back to raw request", err);
            return fetch(req);
        }
    })());
});