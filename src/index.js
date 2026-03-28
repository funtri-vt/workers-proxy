import { injectHTMLRewriter } from './rewriter.js';
import launcherHtml from './launcher.html';
import interceptorJs from '../build/client-interceptor.raw.js';
import swJs from './proxy-sw.raw.js';
import adminHtml from './admin.html';
import { isInternalTarget } from './worker-utils.js';

async function getSystemConfig(env) {
    let isConfigured = '0';
    let hashLength = '32';

    if (env.CONFIG_KV) {
        isConfigured = await env.CONFIG_KV.get('DATABASE_CONFIGURED') || null;
        hashLength = await env.CONFIG_KV.get('HASH_LENGTH') || null;
    }

    // Cache Miss: Query Database and update KV Cache
    if (isConfigured === null || hashLength === null) {
        if (env.DB) {
            const { results } = await env.DB.prepare("SELECT config_key, config_value FROM database_config").all();
            if (results) {
                const confMap = {};
                results.forEach(r => confMap[r.config_key] = r.config_value);
                isConfigured = confMap['DATABASE_CONFIGURED'] || '0';
                hashLength = confMap['HASH_LENGTH'] || '32';
                
                if (env.CONFIG_KV) {
                    await env.CONFIG_KV.put('DATABASE_CONFIGURED', isConfigured);
                    await env.CONFIG_KV.put('HASH_LENGTH', hashLength);
                }
            }
        }
    }
    return { DATABASE_CONFIGURED: isConfigured || '0', HASH_LENGTH: parseInt(hashLength, 10) || 32 };
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        // Fallback to auto-detecting proxy base if env variable isn't set
        const PROXY_BASE = env.PROXY_DOMAIN || url.hostname.split('.').slice(-2).join('.'); 

        const config = await getSystemConfig(env);
        const hashLength = config.HASH_LENGTH;

        // 1. Base Domain Routing (The Launcher & Admin)
        if (url.hostname === PROXY_BASE || url.hostname === `www.${PROXY_BASE}`) {
            if (url.hostname === `www.${PROXY_BASE}`) return Response.redirect(`https://${PROXY_BASE}/`, 301);

            // Public API for Client Scripts
            if (url.pathname === '/api/config/public') {
                return new Response(JSON.stringify({ hashLength }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            }

            // OOBE Lockout - Force Admin Configuration
            if (config.DATABASE_CONFIGURED === '0' && !url.pathname.startsWith('/__admin')) {
                return new Response("Service Unavailable: Proxy system pending admin configuration. Please visit /__admin to set up the system.", { status: 503 });
            }

            if (url.pathname === '/') return new Response(launcherHtml, { headers: { 'Content-Type': 'text/html' } });

            // --- ADMIN PANEL SECURE ROUTING ---
            if (url.pathname.startsWith('/__admin')) {
                const userIdentifier = extractUserIdentifier(request);
                
                if (!env.ADMIN_EMAIL || userIdentifier !== env.ADMIN_EMAIL) {
                    return new Response("Forbidden: Admin access requires authentication matching the ADMIN_EMAIL variable.", { status: 403 });
                }

                if (url.pathname === '/__admin') return new Response(adminHtml, { headers: { 'Content-Type': 'text/html' } });

                // Configuration API
                if (url.pathname === '/__admin/api/config') {
                    if (request.method === 'GET') {
                        return new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } });
                    } else if (request.method === 'POST') {
                        const body = await request.json();
                        const newLen = parseInt(body.HASH_LENGTH, 10);
                        if (newLen >= 16 && newLen <= 63) {
                            await env.DB.prepare("UPDATE database_config SET config_value = ? WHERE config_key = 'HASH_LENGTH'").bind(newLen.toString()).run();
                            await env.DB.prepare("UPDATE database_config SET config_value = '1' WHERE config_key = 'DATABASE_CONFIGURED'").run();
                            if (env.CONFIG_KV) {
                                await env.CONFIG_KV.put('HASH_LENGTH', newLen.toString());
                                await env.CONFIG_KV.put('DATABASE_CONFIGURED', '1');
                            }
                            return new Response(JSON.stringify({ success: true }));
                        }
                        return new Response("Invalid HASH_LENGTH", { status: 400 });
                    }
                }

                // Batch Migration API
                if (url.pathname === '/__admin/api/aliases/migrate') {
                    if (request.method === 'POST') {
                        const { migrations } = await request.json();
                        if (Array.isArray(migrations) && migrations.length > 0) {
                            // Run batch query using D1 optimized batch method
                            const stmts = migrations.map(m => 
                                env.DB.prepare("UPDATE domain_aliases SET alias_id = ? WHERE target_domain = ?").bind(m.new_alias_id, m.target_domain)
                            );
                            await env.DB.batch(stmts);
                            return new Response(JSON.stringify({ success: true, migrated: stmts.length }));
                        }
                        return new Response("Invalid payload", { status: 400 });
                    }
                }

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

        // 2. Serve the Client Scripts
        if (url.pathname === '/__proxy/interceptor.js') {
            return new Response(interceptorJs, { headers: { 'Content-Type': 'application/javascript' } });
        }

        if (url.pathname === '/__proxy/sw.js') {
            return new Response(swJs, { 
                headers: { 
                    'Content-Type': 'application/javascript',
                    'Service-Worker-Allowed': '/' 
                } 
            });
        }

        // 3. Hash Routing & Piggyback Registration
        if (url.hostname.endsWith(`.${PROXY_BASE}`)) {
            if (config.DATABASE_CONFIGURED === '0') {
                return new Response("Service Unavailable: Proxy system pending admin configuration.", { status: 503 });
            }

            const aliasHash = url.hostname.split('.')[0];
            let targetDomain = null;
            const pTarget = url.searchParams.get('__ptarget');
            
            if (pTarget) {
                try {
                    targetDomain = atob(pTarget);
                    const expectedHash = await syncHashServer(targetDomain, hashLength);
                
                    if (expectedHash === aliasHash && env.DB) {
                        await env.DB.prepare(`INSERT INTO domain_aliases (alias_id, target_domain) VALUES (?, ?) ON CONFLICT DO NOTHING`)
                                    .bind(aliasHash, targetDomain).run();
                    }
                    url.searchParams.delete('__ptarget');
                } catch(err) {
                    console.error("Invalid base64 in pTarget");
                }
            } else if (env.DB) {
                const result = await env.DB.prepare("SELECT target_domain FROM domain_aliases WHERE alias_id = ?").bind(aliasHash).first();
                if (result) targetDomain = result.target_domain;
            }

            // Fallback to Referer header for sub-resource race conditions
            if (!targetDomain) {
                const referer = request.headers.get('Referer');
                if (referer) {
                    try {
                        const refUrl = new URL(referer);
                        const refPTarget = refUrl.searchParams.get('__ptarget');
                        if (refPTarget) {
                            targetDomain = atob(refPTarget);
                            const expectedHash = await syncHashServer(targetDomain, hashLength);
                            if (expectedHash === aliasHash && env.DB) {
                                await env.DB.prepare(`INSERT INTO domain_aliases (alias_id, target_domain) VALUES (?, ?) ON CONFLICT DO NOTHING`)
                                            .bind(aliasHash, targetDomain).run();
                            }
                        }
                    } catch (e) { /* Ignore invalid referer URLs */ }
                }
            }

            if (!targetDomain) {
                // Return a clean 404 HTML page when the alias subdomain is not recognized
                return new Response(`
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>404 Not Found</title>
                        <style>
                            body {
                                font-family: system-ui, -apple-system, sans-serif;
                                background-color: #f3f4f6;
                                color: #1f2937;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                height: 100vh;
                                margin: 0;
                            }
                            .card {
                                background: white;
                                padding: 2.5rem;
                                border-radius: 0.5rem;
                                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
                                max-width: 24rem;
                                width: 90%;
                            }
                            h1 { color: #dc2626; margin-top: 0; font-size: 1.5rem; }
                            p { margin-bottom: 1rem; color: #4b5563; }
                            ul { padding-left: 1.5rem; color: #4b5563; margin-bottom: 0; }
                            li { margin-bottom: 0.5rem; }
                            a { color: #2563eb; text-decoration: none; font-weight: 500; }
                            a:hover { text-decoration: underline; }
                        </style>
                    </head>
                    <body>
                        <div class="card">
                            <h1>404 Not Found</h1>
                            <p>The proxy could not resolve this domain alias.</p>
                            <p>Try:</p>
                            <ul>
                                <li>Refreshing the page</li>
                                <li><a href="https://${PROXY_BASE}/">Relaunching the proxy</a> from the home page</li>
                            </ul>
                        </div>
                </body>
                </html>
            `, { 
                status: 404, 
                headers: { 'Content-Type': 'text/html; charset=utf-8' } 
            });
            }

            if (isInternalTarget(targetDomain)) {
                return new Response("Forbidden: Access to internal network resources is blocked.", { status: 403 });
            }

            if (env.DB) {
                const blacklistCheck = await env.DB.prepare("SELECT 1 FROM blacklisted_domains WHERE domain = ?").bind(targetDomain).first();
                if (blacklistCheck) return new Response("Forbidden: This domain has been blacklisted by the proxy administrator.", { status: 403 });
            }

            // --- CLIENT-SIDE STATE SYNC API ---
            if (url.pathname === '/__proxy/api/sync') {
                const userId = extractUserIdentifier(request);
                
                if (request.method === 'POST') {
                    try {
                        const body = await request.json();
                        if (env.STATE_BUCKET && targetDomain) {
                            const statePayload = JSON.stringify({
                                localStorage: body.localStorage || {},
                                sessionStorage: body.sessionStorage || {}
                            });
                            
                            // Write directly to R2
                            await env.STATE_BUCKET.put(`${userId}/${targetDomain}.json`, statePayload);
                        }
                        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                    } catch (e) {
                        return new Response(JSON.stringify({ error: "Invalid payload" }), { status: 400 });
                    }
                }
                return new Response("Method not allowed", { status: 405 });
            }

            // --- CLIENT-SIDE COOKIE SYNC API ---
            if (url.pathname === '/__proxy/api/cookies') {
                const userId = extractUserIdentifier(request);
                
                if (request.method === 'GET') {
                    let savedCookies = "";
                    if (env.DB) {
                        const clientPath = url.searchParams.get('path') || '/';
                        const { results } = await env.DB.prepare(`
                            SELECT cookie_name, cookie_value FROM session_cookies 
                            WHERE user_id = ? AND domain = ? AND ? LIKE path || '%' AND (expires_at IS NULL OR expires_at > datetime('now'))
                            ORDER BY LENGTH(path) DESC
                        `).bind(userId, targetDomain, clientPath).all();
                        if (results && results.length > 0) savedCookies = results.map(row => `${row.cookie_name}=${row.cookie_value}`).join('; ');
                    }
                    return new Response(JSON.stringify({ cookies: savedCookies }), { headers: { 'Content-Type': 'application/json' } });
                } else if (request.method === 'POST') {
                    const body = await request.json();
                    const rawCookie = body.raw_cookie;
                    
                    if (rawCookie && env.DB) {
                        const parts = rawCookie.split(';');
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
                            `).bind(userId, targetDomain, cookieName, cookieValue, expiresAt, path, secure, httpOnly, sameSite).run();
                        }
                    }
                    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
                }
            }

            const targetUrl = new URL(url.pathname + url.search, `https://${targetDomain}`);
            const userIdentifier = extractUserIdentifier(request);

            return await processUpstreamFetch(request, targetUrl, userIdentifier, env, PROXY_BASE, hashLength);
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

async function processUpstreamFetch(clientRequest, targetUrl, userId, env, PROXY_BASE, hashLength) {
    let savedCookies = "";
    let storageState = { localStorage: {}, sessionStorage: {} }; 
    
    if (env.DB) {
        // Fetch cookies
        const { results } = await env.DB.prepare(`
            SELECT cookie_name, cookie_value FROM session_cookies 
            WHERE user_id = ? AND domain = ? AND ? LIKE path || '%' AND (expires_at IS NULL OR expires_at > datetime('now'))
            ORDER BY LENGTH(path) DESC
        `).bind(userId, targetUrl.hostname, targetUrl.pathname).all();
        if (results && results.length > 0) savedCookies = results.map(row => `${row.cookie_name}=${row.cookie_value}`).join('; ');
    }

    // Pull storage state efficiently from R2
    if (env.STATE_BUCKET) {
        try {
            const stateObject = await env.STATE_BUCKET.get(`${userId}/${targetUrl.hostname}.json`);
            if (stateObject) {
                const stateData = await stateObject.json();
                if (stateData.localStorage) storageState.localStorage = stateData.localStorage;
                if (stateData.sessionStorage) storageState.sessionStorage = stateData.sessionStorage;
            }
        } catch (e) {
            console.error("Failed to load state from R2:", e);
        }
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
        const redirHash = await syncHashServer(redirTarget.hostname, hashLength);
        const proxyRedirUrl = new URL(redirTarget.pathname + redirTarget.search + redirTarget.hash, `https://${redirHash}.${PROXY_BASE}`);
        proxyRedirUrl.searchParams.set('__ptarget', btoa(redirTarget.hostname));
        responseHeaders.set('Location', proxyRedirUrl.toString());
    }

    const finalResponse = new Response(response.body, { status: response.status, headers: responseHeaders });
    if ((responseHeaders.get('content-type') || '').includes('text/html')) {
        // Pass the R2 storageState into the rewriter
        return injectHTMLRewriter(finalResponse, PROXY_BASE, targetUrl.hostname, savedCookies, storageState, hashLength);
    }
    return finalResponse;
}

function extractUserIdentifier(request) {
    // 1. Primary: Fast path using Cloudflare's native authenticated email header
    const accessEmail = request.headers.get('Cf-Access-Authenticated-User-Email');
    if (accessEmail) {
        return accessEmail;
    }

    // 2. Secondary: Fallback to manually decoding the JWT assertion
    const jwtToken = request.headers.get('Cf-Access-Jwt-Assertion');
    if (jwtToken) {
        try { 
            return JSON.parse(atob(jwtToken.split('.')[1].replace(/-/g, '+').replace(/_/, '/'))).email; 
        } catch (e) {
            // Ignore parse errors and fall through to the IP fallback
        }
    }

    // 3. Tertiary: Fallback to the client's IP or an anonymous default
    return request.headers.get('CF-Connecting-IP') || 'anonymous-user';
}

async function syncHashServer(domain, hashLength = 32) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(domain));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, hashLength);
}
