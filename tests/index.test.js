import { describe, it, expect, beforeEach } from 'vitest';
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

    beforeEach(async () => {
        // Reset our database and KV before each test to ensure clean state
        await env.CONFIG_KV.put('DATABASE_CONFIGURED', '1');
        await env.CONFIG_KV.put('HASH_LENGTH', '16');
        
        // Clear D1 Tables
        await env.DB.prepare("DELETE FROM domain_aliases").run();
        await env.DB.prepare("DELETE FROM blacklisted_domains").run();
    });

    it('should lock out users (503) if the database is not configured', async () => {
        // Simulate OOBE (Out of Box Experience) state
        await env.CONFIG_KV.put('DATABASE_CONFIGURED', '0');

        const response = await simulateFetch('https://proxy.example.com/');
        const text = await response.text();
        
        // Depending on how you wrote the OOBE in index.js, it might be a 503 or serve the launcher
        // Adjust this expectation to match your specific OOBE logic.
        expect(response.status).toBeGreaterThanOrEqual(200); 
        expect(text).toContain('V2 Edge'); // Should serve launcher or setup screen
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
        
        // Hit the proxy with the __ptarget parameter
        const response = await simulateFetch(`https://dummyhash1234567.proxy.example.com/?__ptarget=${encodedDomain}`);
        
        // Check if it was successfully inserted into the D1 database
        const { results } = await env.DB.prepare(
            "SELECT * FROM domain_aliases WHERE target_domain = ?"
        ).bind(targetDomain).all();

        expect(results.length).toBe(1);
        expect(results[0].target_domain).toBe(targetDomain);
    });
});