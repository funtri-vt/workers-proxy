import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';

describe('V2 Edge Proxy - Main Router (index.js)', () => {
    
    // Helper to simulate a fetch event
    async function simulateFetch(url, requestInit = {}) {
        const request = new Request(url, requestInit);
        const ctx = createExecutionContext();
        const response = await worker.fetch(request, env, ctx);
        await waitOnExecutionContext(ctx); // Ensure background tasks finish
        return response;
    }

    beforeAll(async () => {
        // Initialize the D1 database tables using prepare().run() to bypass Miniflare multi-line parsing bugs
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS domain_aliases (alias_id TEXT PRIMARY KEY, target_domain TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS blacklisted_domains (domain TEXT PRIMARY KEY, added_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS database_config (config_key TEXT PRIMARY KEY, config_value TEXT NOT NULL)").run();
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS session_cookies (user_id TEXT NOT NULL, domain TEXT NOT NULL, cookie_name TEXT NOT NULL, cookie_value TEXT NOT NULL, expires_at DATETIME, path TEXT DEFAULT '/', secure INTEGER DEFAULT 0, http_only INTEGER DEFAULT 0, same_site TEXT DEFAULT 'Lax', PRIMARY KEY (user_id, domain, cookie_name, path))").run();
    });

    beforeEach(async () => {
        // Reset our database and KV before each test to ensure clean state
        await env.CONFIG_KV.put('DATABASE_CONFIGURED', '1');
        await env.CONFIG_KV.put('HASH_LENGTH', '16');
        
        // Clear D1 Tables safely now that they exist
        await env.DB.prepare("DELETE FROM domain_aliases").run();
        await env.DB.prepare("DELETE FROM blacklisted_domains").run();
    });

    it('should lock out users (503) if the database is not configured', async () => {
        // Simulate OOBE (Out of Box Experience) state
        await env.CONFIG_KV.put('DATABASE_CONFIGURED', '0');

        const response = await simulateFetch('https://proxy.example.com/');
        const text = await response.text();
        
        // Assert the exact 503 behavior from index.js
        expect(response.status).toBe(503); 
        expect(text).toContain('Service Unavailable: Proxy system pending admin configuration');
    });

    it('should block requests to blacklisted domains (403)', async () => {
        // Add a domain to the mocked D1 blacklist
        await env.DB.prepare(
            "INSERT INTO blacklisted_domains (domain) VALUES (?)"
        ).bind('evil-tracker.com').run();

        // Simulate a piggyback registration for a blacklisted domain
        const encodedEvilDomain = btoa('evil-tracker.com');
        const response = await simulateFetch(`https://a1b2c3d4e5f6g7h8.proxy.example.com/?__ptarget=${encodedEvilDomain}`);
        
        expect(response.status).toBe(403);
    });

    it('should process piggyback registration and store in D1', async () => {
        const targetDomain = 'wikipedia.org';
        const encodedDomain = btoa(targetDomain);
        
        // 1. Calculate the real SHA-256 hash so the proxy's security check passes!
        const data = new TextEncoder().encode(targetDomain);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const validHash = Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .substring(0, 16); // Using the 16 length from our beforeEach hook
        
        // 2. Hit the proxy with the CORRECT hash and __ptarget parameter
        const response = await simulateFetch(`https://${validHash}.proxy.example.com/?__ptarget=${encodedDomain}`);
        
        // 3. Check if it was successfully inserted into the D1 database
        const { results } = await env.DB.prepare(
            "SELECT * FROM domain_aliases WHERE target_domain = ?"
        ).bind(targetDomain).all();

        expect(results.length).toBe(1);
        expect(results[0].target_domain).toBe(targetDomain);
        expect(results[0].alias_id).toBe(validHash);
    });
});