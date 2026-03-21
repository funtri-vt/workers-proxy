import { injectHTMLRewriter } from './rewriter.js';
import launcherHtml from './launcher.html';
import interceptorJs from '../build/client-interceptor.raw.js';
import adminHtml from './admin.html';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        // Fallback to auto-detecting proxy base if env variable isn't set
        const PROXY_BASE = env.PROXY_DOMAIN || url.hostname.split('.').slice(-2).join('.'); 

        // 1. Base Domain Routing (The Launcher & Admin)
        if (url.hostname === PROXY_BASE || url.hostname === `www.${PROXY_BASE}`) {
            // Redirect www directly to the clean root domain launcher
            if (url.hostname === `www.${PROXY_BASE}`) {
                return Response.redirect(`https://${PROXY_BASE}/`, 301);
            }

            if (url.pathname === '/') {
                return new Response(launcherHtml, { headers: { 'Content-Type': 'text/html' } });
            }

            // --- ADMIN PANEL SECURE ROUTING ---
            if (url.pathname.startsWith('/__admin')) {
                const userIdentifier = extractUserIdentifier(request);
                
                // Block access if no ADMIN_EMAIL is set or if the user doesn't match
                if (!env.ADMIN_EMAIL || userIdentifier !== env.ADMIN_EMAIL) {
                    return new Response("Forbidden: Admin access requires authentication matching the ADMIN_EMAIL variable.", { status: 403 });
                }

                if (url.pathname === '/__admin') {
                    return new Response(adminHtml, { headers: { 'Content-Type': 'text/html' } });
                }

                if (url.pathname === '/__admin/api/aliases') {
                    if (request.method === 'GET') {
                        const { results } = await env.DB.prepare("SELECT * FROM domain_aliases ORDER BY created_at DESC LIMIT 200").all();
                        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' } });
                    } else if (request.method === 'DELETE') {
                        const { alias_id } = await request.json();
                        await env.DB.prepare("DELETE FROM domain_aliases WHERE alias_id = ?").bind(alias_id).run();
                        return new Response(JSON.stringify({ success: true }));
                    }
                }

                if (url.pathname === '/__admin/api/sessions') {
                    if (request.method === 'GET') {
                        const { results } = await env.DB.prepare("SELECT user_id, domain, cookie_name, expires_at FROM session_cookies ORDER BY domain LIMIT 200").all();
                        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' } });
                    } else if (request.method === 'DELETE') {
                        const { user_id, domain, cookie_name } = await request.json();
                        await env.DB.prepare("DELETE FROM session_cookies WHERE user_id = ? AND domain = ? AND cookie_name = ?").bind(user_id, domain, cookie_name).run();
                        return new Response(JSON.stringify({ success: true }));
                    }
                }
                return new Response("Admin Endpoint Not Found", { status: 404 });
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
                
                // Clean the URL before proxying upstream, skipping the 302 redirect
                url.searchParams.delete('__ptarget');
                
            } else if (env.DB) {
                const result = await env.DB.prepare("SELECT target_domain FROM domain_aliases WHERE alias_id = ?").bind(aliasHash).first();
                if (result) targetDomain = result.target_domain;
            }

            if (!targetDomain) return new Response("Unknown Alias Subdomain. Please start from the Launcher.", { status: 404 });

            // url.search naturally reflects the deleted __ptarget param here
            const targetUrl = new URL(url.pathname + url.search, `https://${targetDomain}`);
            
            // Extract user reliably. Fallback to IP address if Access is not used.
            const userIdentifier = extractUserIdentifier(request);

            return await processUpstreamFetch(request, targetUrl, userIdentifier, env, PROXY_BASE);
        }
        return new Response("Invalid Route", { status: 404 });
    },
    async scheduled(event, env, ctx) {
        if (env.DB) {
            try {
                const result = await env.DB.prepare(
                    "DELETE FROM session_cookies WHERE expires_at <= datetime('now')"
                ).run();
                console.log(`🧹 Swept ${result.meta.changes} expired cookies from the vault.`);
            } catch (err) {
                console.error("Failed to sweep cookies:", err);
            }
        }
    }
};

async function processUpstreamFetch(clientRequest, targetUrl, userId, env, PROXY_BASE) {
    let savedCookies = "";
    
    // Inject valid cookies into the outgoing request, matching domain and path
    if (env.DB) {
        const { results } = await env.DB.prepare(`
            SELECT cookie_name, cookie_value FROM session_cookies 
            WHERE user_id = ? AND domain = ? AND ? LIKE path || '%' AND (expires_at IS NULL OR expires_at > datetime('now'))
        `).bind(userId, targetUrl.hostname, targetUrl.pathname).all();
        
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
    const upgradeHeader = clientRequest.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        targetUrl.protocol = targetUrl.protocol.replace('http', 'ws');
        return await fetch(new Request(targetUrl, { method: clientRequest.method, headers: proxyHeaders }));
    }

    // Prevent TypeError by conditionally omitting the body for GET/HEAD requests
    const fetchInit = { 
        method: clientRequest.method, 
        headers: proxyHeaders, 
        redirect: 'manual' 
    };
    if (!['GET', 'HEAD'].includes(clientRequest.method.toUpperCase()) && clientRequest.body) {
        fetchInit.body = clientRequest.body;
    }

    const response = await fetch(new Request(targetUrl, fetchInit));
    const responseHeaders = new Headers(response.headers);

    // The Cookie Vault: Parse and Store Set-Cookie securely with Full Metadata
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
                let path = '/';
                let secure = 0;
                let httpOnly = 0;
                let sameSite = 'Lax';

                // Extract all metadata
                for (let i = 1; i < parts.length; i++) {
                    const partStr = parts[i].trim();
                    const partStrLower = partStr.toLowerCase();

                    if (partStrLower.startsWith('expires=')) {
                        const dateStr = partStr.substring(8);
                        expiresAt = new Date(dateStr).toISOString().replace('T', ' ').substring(0, 19);
                    } else if (partStrLower.startsWith('max-age=')) {
                        const maxAge = parseInt(partStr.substring(8), 10);
                        expiresAt = new Date(Date.now() + maxAge * 1000).toISOString().replace('T', ' ').substring(0, 19);
                    } else if (partStrLower.startsWith('path=')) {
                        path = partStr.substring(5) || '/';
                    } else if (partStrLower === 'secure') {
                        secure = 1;
                    } else if (partStrLower === 'httponly') {
                        httpOnly = 1;
                    } else if (partStrLower.startsWith('samesite=')) {
                        sameSite = partStr.substring(9);
                    }
                }

                await env.DB.prepare(`
                    INSERT INTO session_cookies (user_id, domain, cookie_name, cookie_value, expires_at, path, secure, http_only, same_site) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) 
                    ON CONFLICT(user_id, domain, cookie_name, path) DO UPDATE SET 
                    cookie_value = excluded.cookie_value,
                    expires_at = excluded.expires_at,
                    secure = excluded.secure,
                    http_only = excluded.http_only,
                    same_site = excluded.same_site
                `).bind(userId, targetUrl.hostname, cookieName, cookieValue, expiresAt, path, secure, httpOnly, sameSite).run();
            }
        }
    }

    // Strip problematic headers
    responseHeaders.delete('Content-Security-Policy');
    responseHeaders.delete('X-Frame-Options');
    responseHeaders.delete('Set-Cookie'); // Prevent the client browser from seeing the upstream cookie
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    // Rewrite 301/302 Redirect Locations safely retaining query parameters and hashes
    if (responseHeaders.has('Location')) {
        const redirTarget = new URL(responseHeaders.get('Location'), targetUrl.origin);
        const redirHash = await syncHashServer(redirTarget.hostname);
        
        const proxyRedirUrl = new URL(redirTarget.pathname + redirTarget.search + redirTarget.hash, `https://${redirHash}.${PROXY_BASE}`);
        proxyRedirUrl.searchParams.set('__ptarget', btoa(redirTarget.hostname));
        
        responseHeaders.set('Location', proxyRedirUrl.toString());
    }

    const finalResponse = new Response(response.body, { status: response.status, headers: responseHeaders });

    // Only inject HTMLRewriter on actual HTML pages
    if ((responseHeaders.get('content-type') || '').includes('text/html')) {
        return injectHTMLRewriter(finalResponse, PROXY_BASE, targetUrl.hostname);
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
    // Fallback for testing: Use the client's IP address to isolate sessions
    return request.headers.get('CF-Connecting-IP') || 'anonymous-user';
}

async function syncHashServer(domain) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(domain));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}