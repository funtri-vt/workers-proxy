import { describe, it, expect, beforeAll } from 'vitest';
import { ProxyInterceptor, ProxyInterceptor } from  '../src/client-interceptor.source'
// Mock the window object so the client-interceptor doesn't crash on import
beforeAll(() => {
    globalThis.window = { 
        __PROXY_HASH_LENGTH__: 16, 
        __PROXY_DOMAIN__: 'workers-proxy.com' 
    };
});

describe('Hash Parity Validation', () => {
    
    // Note: You will need to export syncHashServer from index.js or rewriter.js to test it here
    // For this test, we replicate the server logic exactly as it is in your worker
    async function serverWebCryptoHash(domain, hashLength = 16) {
        const data = new TextEncoder().encode(domain);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .substring(0, hashLength);
    }

    

    it('should generate identical hashes on Client JS and Server WebCrypto', async () => {
        const testDomains = [
            'google.com',
            'discord.com',
            'api.github.com',
            'sub.domain.co.uk',
            'very-long-domain-name-with-hyphens.org'
        ];

        for (const domain of testDomains) {
            const serverHash = await serverWebCryptoHash(domain, 16);
            const proxyInterceptor = new ProxyInterceptor("google.com", 16)
            const clientHash = proxyInterceptor.syncHash(domain);
            
            // This is the most critical assertion in the proxy architecture
            expect(clientHash).toBe(serverHash);
        }
    });
});