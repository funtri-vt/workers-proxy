import { describe, it, expect, beforeAll } from 'vitest';

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

    // A lightweight version of your pure JS syncHash for testing purposes
    // In reality, you'd import this directly from client-interceptor.source.js
    function clientSyncHash(ascii, hashLength = 16) {
        function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
        let mathPow = Math.pow, maxWord = mathPow(2, 32), lengthProperty = 'length';
        let i, j, result = '', words = [], asciiBitLength = ascii[lengthProperty] * 8;
        let initHash = [], k = [], primeCounter = 0, isComposite = {};
        
        for (let candidate = 2; primeCounter < 64; candidate++) {
            if (!isComposite[candidate]) {
                for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
                initHash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
                k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
            }
        }

        ascii += '\x80';
        while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
        for (i = 0; i < ascii[lengthProperty]; i++) {
            j = ascii.charCodeAt(i);
            if (j >> 8) return; // ASCII check
            words[i >> 2] |= j << ((3 - i) % 4) * 8;
        }
        words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
        words[words[lengthProperty]] = (asciiBitLength);

        for (j = 0; j < words[lengthProperty];) {
            let w = words.slice(j, j += 16), oldHash = initHash;
            initHash = initHash.slice(0, 8);
            for (i = 0; i < 64; i++) {
                let w15 = w[i - 15], w2 = w[i - 2];
                let a = initHash[0], e = initHash[4];
                let temp1 = initHash[7] + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) + ((e & initHash[5]) ^ ((~e) & initHash[6])) + k[i] + (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) | 0);
                let temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) + ((a & initHash[1]) ^ (a & initHash[2]) ^ (initHash[1] & initHash[2]));
                initHash = [(temp1 + temp2) | 0].concat(initHash);
                initHash[4] = (initHash[4] + temp1) | 0;
            }
            for (i = 0; i < 8; i++) initHash[i] = (initHash[i] + oldHash[i]) | 0;
        }
        
        for (i = 0; i < 8; i++) {
            for (j = 3; j + 1; j--) {
                let b = (initHash[i] >> (j * 8)) & 255;
                result += ((b < 16) ? 0 : '') + b.toString(16);
            }
        }
        return result.substring(0, hashLength);
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
            const clientHash = clientSyncHash(domain, 16);
            
            // This is the most critical assertion in the proxy architecture
            expect(clientHash).toBe(serverHash);
        }
    });
});