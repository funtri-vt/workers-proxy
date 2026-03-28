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
        
        // ADDED: Initialize the audit table for migrations
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS migration_audit (audit_id TEXT PRIMARY KEY, operator TEXT NOT NULL, payload_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
    });

    beforeEach(async () => {
        // Reset our database and KV before each test to ensure clean state
        await env.CONFIG_KV.put('DATABASE_CONFIGURED', '1');
        await env.CONFIG_KV.put('HASH_LENGTH', '16');
        
        // Clear D1 Tables safely now that they exist
        await env.DB.prepare("DELETE FROM domain_aliases").run();
        await env.DB.prepare("DELETE FROM blacklisted_domains").run();
        await env.DB.prepare("DELETE FROM migration_audit").run();
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

    // --- NEW: Batch Migration Tests ---
    describe('Admin API - Batch Migrations', () => {
        beforeEach(async () => {
            // Seed specific aliases for migration tests
            await env.DB.prepare("INSERT INTO domain_aliases (alias_id, target_domain) VALUES ('old1', 'test1.com'), ('old2', 'test2.com')").run();
            
            // Set up mock admin credentials in the environment
            env.ADMIN_EMAIL = 'admin@example.com';
        });

        // Helper for admin headers
        const adminHeaders = {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'admin@example.com' // Matches env.ADMIN_EMAIL
        };

        it('SERVER: should successfully process a valid batch within a transaction', async () => {
            const payload = {
                migrations: [
                    { target_domain: 'test1.com', new_alias_id: 'new1', old_alias_id: 'old1' },
                    { target_domain: 'test2.com', new_alias_id: 'new2', old_alias_id: 'old2' }
                ],
                dryRun: false
            };

            // Use the base domain (example.com) to correctly route to the admin handler
            const response = await simulateFetch('https://example.com/__admin/api/aliases/migrate', {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: adminHeaders
            });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.success).toBe(true);
            expect(data.migrated).toBe(2);
            expect(data.audit_id).toBeDefined();

            // Verify DB state actually updated
            const { results } = await env.DB.prepare("SELECT alias_id FROM domain_aliases WHERE target_domain = 'test1.com'").all();
            expect(results[0].alias_id).toBe('new1');
        });

        it('SERVER: should accurately reflect a dry-run without modifying the database', async () => {
            const payload = {
                migrations: [{ target_domain: 'test1.com', new_alias_id: 'new1', old_alias_id: 'old1' }],
                dryRun: true
            };

            const response = await simulateFetch('https://example.com/__admin/api/aliases/migrate', {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: adminHeaders
            });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.migrated).toBe(1);

            // Verify DB was NOT modified
            const { results } = await env.DB.prepare("SELECT alias_id FROM domain_aliases WHERE target_domain = 'test1.com'").all();
            expect(results[0].alias_id).toBe('old1'); 
        });

        it('SERVER: should reject payloads exceeding the MAX_BATCH limit of 200', async () => {
            const largeBatch = Array.from({ length: 201 }, (_, i) => ({
                target_domain: `site${i}.com`, new_alias_id: `hash${i}`
            }));

            const response = await simulateFetch('https://example.com/__admin/api/aliases/migrate', {
                method: 'POST',
                body: JSON.stringify({ migrations: largeBatch }),
                headers: adminHeaders
            });
            
            // Now correctly expects the 413 Payload Too Large
            expect(response.status).toBe(413);
        });
    });
});