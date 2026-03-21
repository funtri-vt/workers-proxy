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
            if (url.hostname === `www.${PROXY_BASE}`) return Response.redirect(`https://${PROXY_BASE}/`, 301);
            if (url.pathname === '/') return new Response(launcherHtml, { headers: { 'Content-Type': 'text/html' } });

            // --- ADMIN PANEL SECURE ROUTING ---
            if (url.pathname.startsWith('/__admin')) {
                const userIdentifier = extractUserIdentifier(request);
                
                if (!env.ADMIN_EMAIL || userIdentifier !== env.ADMIN_EMAIL) {
                    return new Response("Forbidden: Admin access requires authentication matching the ADMIN_EMAIL variable.", { status: 403 });
                }

                if (url.pathname === '/__admin') return new Response(adminHtml, { headers: { 'Content-Type': 'text/html' } });

                if (url.pathname === '/__admin/api/aliases') {
                    if (request.method === 'GET') {
                        const qTarget = url.searchParams.get('target');
                        const page = parseInt(url.searchParams.get('page')) || 1;
                        const limit = 200;
                        const offset = (page - 1) * limit;

                        let countQuery = "SELECT COUNT(*) as total FROM domain_aliases";
                        let query = "SELECT * FROM domain_aliases";
                        let params = [];
                        
                        if (qTarget) { 
                            countQuery += " WHERE target_domain LIKE ?";
                            query += " WHERE target_domain LIKE ?"; 
                            params.push(`%${qTarget}%`); 
                        }

                        const totalRes = await env.DB.prepare(countQuery).bind(...params).first();
                        const totalPages = Math.ceil((totalRes ? totalRes.total : 0) / limit) || 1;

                        query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
                        params.push(limit, offset);
                        
                        const { results } = await env.DB.prepare(query).bind(...params).all();
                        return new Response(JSON.stringify({ items: results || [], totalPages }), { headers: { 'Content-Type': 'application/json' } });
                    } else if (request.method === 'DELETE') {
                        const { alias_id } = await request.json();
                        await env.DB.prepare("DELETE FROM domain_aliases WHERE alias_id = ?").bind(alias_id).run();
                        return new Response(JSON.stringify({ success: true }));
                    }
                }

                if (url.pathname === '/__admin/api/sessions') {
                    if (request.method === 'GET') {
                        const qUser = url.searchParams.get('user');
                        const qDomain = url.searchParams.get('domain');
                        const page = parseInt(url.searchParams.get('page')) || 1;
                        const limit = 200;
                        const offset = (page - 1) * limit;

                        let countQuery = "SELECT COUNT(*) as total FROM session_cookies WHERE 1=1";
                        let query = "SELECT user_id, domain, cookie_name, expires_at FROM session_cookies WHERE 1=1";
                        let params = [];
                        
                        if (qUser) { 
                            countQuery += " AND user_id LIKE ?";
                            query += " AND user_id LIKE ?"; 
                            params.push(`%${qUser}%`); 
                        }
                        if (qDomain) { 
                            countQuery += " AND domain LIKE ?";
                            query += " AND domain LIKE ?"; 
                            params.push(`%${qDomain}%`); 
                        }

                        const totalRes = await env.DB.prepare(countQuery).bind(...params).first();
                        const totalPages = Math.ceil((totalRes ? totalRes.total : 0) / limit) || 1;

                        query += " ORDER BY domain LIMIT ? OFFSET ?";
                        params.push(limit, offset);

                        const { results } = await env.DB.prepare(query).bind(...params).all();
                        return new Response(JSON.stringify({ items: results || [], totalPages }), { headers: { 'Content-Type': 'application/json' } });
                    } else if (request.method === 'DELETE') {
                        const { user_id, domain, cookie_name } = await request.json();
                        await env.DB.prepare("DELETE FROM session_cookies WHERE user_id = ? AND domain = ? AND cookie_name = ?").bind(user_id, domain, cookie_name).run();
                        return new Response(JSON.stringify({ success: true }));
                    }
                }

                if (url.pathname === '/__admin/api/blacklist') {
                    if (request.method === 'GET') {
                        const qDomain = url.searchParams.get('domain');
                        const page = parseInt(url.searchParams.get('page')) || 1;
                        const limit = 200;
                        const offset = (page - 1) * limit;

                        let countQuery = "SELECT COUNT(*) as total FROM blacklisted_domains";
                        let query = "SELECT domain, added_at FROM blacklisted_domains";
                        let params = [];
                        
                        if (qDomain) { 
                            countQuery += " WHERE domain LIKE ?";
                            query += " WHERE domain LIKE ?"; 
                            params.push(`%${qDomain}%`); 
                        }

                        const totalRes = await env.DB.prepare(countQuery).bind(...params).first();
                        const totalPages = Math.ceil((totalRes ? totalRes.total : 0) / limit) || 1;

                        query += " ORDER BY added_at DESC LIMIT ? OFFSET ?";
                        params.push(limit, offset);

                        const { results } = await env.DB.prepare(query).bind(...params).all();
                        return new Response(JSON.stringify({ items: results || [], totalPages }), { headers: { 'Content-Type': 'application/json' } });
                    } else if (request.method === 'POST') {
                        const { domain } = await request.json();
                        if (!domain) return new Response("Domain is required", { status: 400 });
                        await env.DB.prepare("INSERT INTO blacklisted_domains (domain) VALUES (?) ON CONFLICT DO NOTHING").bind(domain).run();
                        return new Response(JSON.stringify({ success: true }));
                    } else if (request.method === 'DELETE') {
                        const { domain } = await request.json();
                        await env.DB.prepare("DELETE FROM blacklisted_domains WHERE domain = ?").bind(domain).run();
                        return new Response(JSON.stringify({ success: true }));
                    }
                }
                return new Response("Admin Endpoint Not Found", { status: 404 });
            }
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
                url.searchParams.delete('__ptarget');
            } else if (env.DB) {
                const result = await env.DB.prepare("SELECT target_domain FROM domain_aliases WHERE alias_id = ?").bind(aliasHash).first();
                if (result) targetDomain = result.target_domain;
            }

            if (!targetDomain) return new Response("Unknown Alias Subdomain. Please start from the Launcher.", { status: 404 });

            if (env.DB) {
                const blacklistCheck = await env.DB.prepare("SELECT 1 FROM blacklisted_domains WHERE domain = ?").bind(targetDomain).first();
                if (blacklistCheck) return new Response("Forbidden: This domain has been blacklisted by the proxy administrator.", { status: 403 });
            }

            const targetUrl = new URL(url.pathname + url.search, `https://${targetDomain}`);
            const userIdentifier = extractUserIdentifier(request);

            return await processUpstreamFetch(request, targetUrl, userIdentifier, env, PROXY_BASE);
        }
        return new Response("Invalid Route", { status: 404 });
    },
    async scheduled(event, env, ctx) {
        if (env.DB) {
            try {
                const result = await env.DB.prepare("DELETE FROM session_cookies WHERE expires_at <= datetime('now')").run();
                console.log(`🧹 Swept ${result.meta.changes} expired cookies from the vault.`);
            } catch (err) { console.error("Failed to sweep cookies:", err); }
        }
    }
};

async function processUpstreamFetch(clientRequest, targetUrl, userId, env, PROXY_BASE) {
    let savedCookies = "";
    if (env.DB) {
        const { results } = await env.DB.prepare(`
            SELECT cookie_name, cookie_value FROM session_cookies 
            WHERE user_id = ? AND domain = ? AND ? LIKE path || '%' AND (expires_at IS NULL OR expires_at > datetime('now'))
        `).bind(userId, targetUrl.hostname, targetUrl.pathname).all();
        if (results && results.length > 0) savedCookies = results.map(row => `${row.cookie_name}=${row.cookie_value}`).join('; ');
    }

    const proxyHeaders = new Headers(clientRequest.headers);
    proxyHeaders.set('Host', targetUrl.hostname);
    if (proxyHeaders.has('Origin')) proxyHeaders.set('Origin', targetUrl.origin);
    if (proxyHeaders.has('Referer')) proxyHeaders.delete('Referer'); // Privacy
    if (savedCookies) proxyHeaders.set('Cookie', savedCookies);

    const upgradeHeader = clientRequest.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        targetUrl.protocol = targetUrl.protocol.replace('http', 'ws');
        return await fetch(new Request(targetUrl, { method: clientRequest.method, headers: proxyHeaders }));
    }

    const fetchInit = { method: clientRequest.method, headers: proxyHeaders, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(clientRequest.method.toUpperCase()) && clientRequest.body) {
        fetchInit.body = clientRequest.body;
    }

    const response = await fetch(new Request(targetUrl, fetchInit));
    const responseHeaders = new Headers(response.headers);

    const setCookieHeaders = responseHeaders.getSetCookie(); 
    if (setCookieHeaders.length > 0 && env.DB) {
        for (const cookieString of setCookieHeaders) {
            const parts = cookieString.split(';');
            const mainPart = parts[0];
            const equalIndex = mainPart.indexOf('=');
            
            if (equalIndex > -1) {
                const cookieName = mainPart.slice(0, equalIndex).trim();
                const cookieValue = mainPart.slice(equalIndex + 1).trim();
                let expiresAt = null, path = '/', secure = 0, httpOnly = 0, sameSite = 'Lax';

                for (let i = 1; i < parts.length; i++) {
                    const partStr = parts[i].trim();
                    const partStrLower = partStr.toLowerCase();
                    if (partStrLower.startsWith('expires=')) expiresAt = new Date(partStr.substring(8)).toISOString().replace('T', ' ').substring(0, 19);
                    else if (partStrLower.startsWith('max-age=')) expiresAt = new Date(Date.now() + parseInt(partStr.substring(8), 10) * 1000).toISOString().replace('T', ' ').substring(0, 19);
                    else if (partStrLower.startsWith('path=')) path = partStr.substring(5) || '/';
                    else if (partStrLower === 'secure') secure = 1;
                    else if (partStrLower === 'httponly') httpOnly = 1;
                    else if (partStrLower.startsWith('samesite=')) sameSite = partStr.substring(9);
                }

                await env.DB.prepare(`
                    INSERT INTO session_cookies (user_id, domain, cookie_name, cookie_value, expires_at, path, secure, http_only, same_site) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) 
                    ON CONFLICT(user_id, domain, cookie_name, path) DO UPDATE SET 
                    cookie_value = excluded.cookie_value, expires_at = excluded.expires_at, secure = excluded.secure, http_only = excluded.http_only, same_site = excluded.same_site
                `).bind(userId, targetUrl.hostname, cookieName, cookieValue, expiresAt, path, secure, httpOnly, sameSite).run();
            }
        }
    }

    responseHeaders.delete('Content-Security-Policy');
    responseHeaders.delete('X-Frame-Options');
    responseHeaders.delete('Set-Cookie'); 
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    if (responseHeaders.has('Location')) {
        const redirTarget = new URL(responseHeaders.get('Location'), targetUrl.origin);
        const redirHash = await syncHashServer(redirTarget.hostname);
        const proxyRedirUrl = new URL(redirTarget.pathname + redirTarget.search + redirTarget.hash, `https://${redirHash}.${PROXY_BASE}`);
        proxyRedirUrl.searchParams.set('__ptarget', btoa(redirTarget.hostname));
        responseHeaders.set('Location', proxyRedirUrl.toString());
    }

    const finalResponse = new Response(response.body, { status: response.status, headers: responseHeaders });
    if ((responseHeaders.get('content-type') || '').includes('text/html')) {
        return injectHTMLRewriter(finalResponse, PROXY_BASE, targetUrl.hostname);
    }
    return finalResponse;
}

function extractUserIdentifier(request) {
    const jwtToken = request.headers.get('Cf-Access-Jwt-Assertion');
    if (jwtToken) {
        try { return JSON.parse(atob(jwtToken.split('.')[1].replace(/-/g, '+').replace(/_/, '/'))).email; } catch (e) {}
    }
    return request.headers.get('CF-Connecting-IP') || 'anonymous-user';
}

async function syncHashServer(domain) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(domain));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}