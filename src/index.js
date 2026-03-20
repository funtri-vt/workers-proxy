import { injectHTMLRewriter } from './rewriter.js';
import launcherHtml from './launcher.html';
import interceptorJs from './client-interceptor.raw.js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        // Fallback to auto-detecting proxy base if env variable isn't set
        const PROXY_BASE = env.PROXY_DOMAIN || url.hostname.split('.').slice(-2).join('.'); 

        // 1. Base Domain Routing (The Launcher)
        if (url.hostname === PROXY_BASE || url.hostname === `www.${PROXY_BASE}`) {
            // Redirect www directly to the clean root domain launcher
            if (url.hostname === `www.${PROXY_BASE}`) {
                return Response.redirect(`https://${PROXY_BASE}/`, 301);
            }

            if (url.pathname === '/') {
                return new Response(launcherHtml, { headers: { 'Content-Type': 'text/html' } });
            }
            
            // If they type proxy.com/random-path, safely redirect back to the launcher
            return Response.redirect(`https://${PROXY_BASE}/`, 302);
        }

        // 2. Serve the Client Interceptor Script
        if (url.pathname === '/__proxy/interceptor.js') {
            return new Response(interceptorJs, { headers: { 'Content-Type': 'application/javascript' } });
        }

        // 3. Hash Routing & Piggyback Registration
        if (url.hostname.endsWith(`.${PROXY_BASE}`)) {
            const aliasHash = url.hostname.split('.')[0];
            let targetDomain = null;
            const pTarget = url.searchParams.get('__ptarget');
            
            if (pTarget) {
                targetDomain = atob(pTarget);
                const expectedHash = await syncHashServer(targetDomain);
                
                if (expectedHash === aliasHash && env.DB) {
                    await env.DB.prepare(`INSERT INTO domain_aliases (alias_id, target_domain) VALUES (?, ?) ON CONFLICT DO NOTHING`)
                                .bind(aliasHash, targetDomain).run();
                }
                
                // Clean the URL before proxying upstream
                const cleanUrl = new URL(request.url);
                cleanUrl.searchParams.delete('__ptarget');
                return Response.redirect(cleanUrl.toString(), 302);
            } else if (env.DB) {
                const result = await env.DB.prepare("SELECT target_domain FROM domain_aliases WHERE alias_id = ?").bind(aliasHash).first();
                if (result) targetDomain = result.target_domain;
            }

            if (!targetDomain) return new Response("Unknown Alias Subdomain. Please start from the Launcher.", { status: 404 });

            const targetUrl = new URL(url.pathname + url.search, `https://${targetDomain}`);
            
            // Extract user reliably. Fallback to IP address if Cloudflare Access is not used.
            const userIdentifier = extractUserIdentifier(request);

            return await processUpstreamFetch(request, targetUrl, userIdentifier, env, PROXY_BASE);
        }
        return new Response("Invalid Route", { status: 404 });
    }
};

async function processUpstreamFetch(clientRequest, targetUrl, userId, env, PROXY_BASE) {
    let savedCookies = "";
    
    // Inject valid cookies into the outgoing request
    if (env.DB) {
        const { results } = await env.DB.prepare(`
            SELECT cookie_name, cookie_value FROM session_cookies 
            WHERE user_id = ? AND domain = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
        `).bind(userId, targetUrl.hostname).all();
        
        if (results && results.length > 0) {
            savedCookies = results.map(row => `${row.cookie_name}=${row.cookie_value}`).join('; ');
        }
    }

    const proxyHeaders = new Headers(clientRequest.headers);
    proxyHeaders.set('Host', targetUrl.hostname);
    if (proxyHeaders.has('Origin')) proxyHeaders.set('Origin', targetUrl.origin);
    if (proxyHeaders.has('Referer')) proxyHeaders.delete('Referer'); // Privacy
    if (savedCookies) proxyHeaders.set('Cookie', savedCookies);

    // Handle WebSockets
    if (clientRequest.headers.get('Upgrade') === 'websocket') {
        targetUrl.protocol = targetUrl.protocol.replace('http', 'ws');
        return await fetch(new Request(targetUrl, { method: clientRequest.method, headers: proxyHeaders }));
    }

    const response = await fetch(new Request(targetUrl, { 
        method: clientRequest.method, 
        headers: proxyHeaders, 
        body: clientRequest.body, 
        redirect: 'manual' 
    }));
    
    const responseHeaders = new Headers(response.headers);

    // The Cookie Vault: Parse and Store Set-Cookie securely
    const setCookieHeaders = responseHeaders.getSetCookie(); 
    if (setCookieHeaders.length > 0 && env.DB) {
        for (const cookieString of setCookieHeaders) {
            const parts = cookieString.split(';');
            const mainPart = parts[0];
            const equalIndex = mainPart.indexOf('=');
            
            if (equalIndex > -1) {
                const cookieName = mainPart.slice(0, equalIndex).trim();
                const cookieValue = mainPart.slice(equalIndex + 1).trim();
                let expiresAt = null;

                // Extract Expiry metadata
                for (let i = 1; i < parts.length; i++) {
                    const part = parts[i].trim().toLowerCase();
                    if (part.startsWith('expires=')) {
                        const dateStr = parts[i].trim().substring(8);
                        // Format specifically for SQLite DATETIME: YYYY-MM-DD HH:MM:SS
                        expiresAt = new Date(dateStr).toISOString().replace('T', ' ').substring(0, 19);
                    } else if (part.startsWith('max-age=')) {
                        const maxAge = parseInt(part.substring(8), 10);
                        expiresAt = new Date(Date.now() + maxAge * 1000).toISOString().replace('T', ' ').substring(0, 19);
                    }
                }

                await env.DB.prepare(`
                    INSERT INTO session_cookies (user_id, domain, cookie_name, cookie_value, expires_at) 
                    VALUES (?, ?, ?, ?, ?) 
                    ON CONFLICT(user_id, domain, cookie_name) DO UPDATE SET 
                    cookie_value = excluded.cookie_value,
                    expires_at = excluded.expires_at
                `).bind(userId, targetUrl.hostname, cookieName, cookieValue, expiresAt).run();
            }
        }
    }

    // Strip problematic headers
    responseHeaders.delete('Content-Security-Policy');
    responseHeaders.delete('X-Frame-Options');
    responseHeaders.delete('Set-Cookie'); // Prevent the client browser from seeing the upstream cookie
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    // Rewrite 301/302 Redirect Locations
    if (responseHeaders.has('Location')) {
        const redirTarget = new URL(responseHeaders.get('Location'), targetUrl.origin);
        const redirHash = await syncHashServer(redirTarget.hostname);
        responseHeaders.set('Location', `https://${redirHash}.${PROXY_BASE}${redirTarget.pathname}?__ptarget=${btoa(redirTarget.hostname)}`);
    }

    const finalResponse = new Response(response.body, { status: response.status, headers: responseHeaders });

    // Only inject HTMLRewriter on actual HTML pages
    if ((responseHeaders.get('content-type') || '').includes('text/html')) {
        return injectHTMLRewriter(finalResponse, PROXY_BASE);
    }

    return finalResponse;
}

function extractUserIdentifier(request) {
    // Attempt to get Cloudflare Access Identity
    const jwtToken = request.headers.get('Cf-Access-Jwt-Assertion');
    if (jwtToken) {
        try { 
            return JSON.parse(atob(jwtToken.split('.')[1].replace(/-/g, '+').replace(/_/, '/'))).email; 
        } catch (e) { /* ignore parse error */ }
    }
    // Fallback for PoC: Use the client's IP address to isolate sessions
    return request.headers.get('CF-Connecting-IP') || 'anonymous-user';
}

async function syncHashServer(domain) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(domain));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}