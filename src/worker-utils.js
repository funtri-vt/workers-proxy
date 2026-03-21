export function isInternalTarget(domain) {
    if (!domain || typeof domain !== 'string') return true;

    let hostname;
    try {
        const urlString = domain.includes('://') ? domain : `http://${domain}`;
        const urlObj = new URL(urlString);
        hostname = urlObj.hostname.toLowerCase();
    } catch (e) {
        return true; 
    }

    // 1. Block known local TLDs
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        return true;
    }

    // 2. Normalize IP (Strip brackets from IPv6 for easier checking)
    const ip = hostname.replace(/[\[\]]/g, '');

    // 3. IPv6 Checks
    if (
        ip === '::1' || // Loopback
        ip === '::' ||  // Unspecified (0.0.0.0)
        ip.startsWith('fc') || ip.startsWith('fd') || // Unique Local Address
        ip.startsWith('fe8') || ip.startsWith('fe9') || // Link-local
        ip.startsWith('fea') || ip.startsWith('feb') || // Link-local
        ip.startsWith('::ffff:') // IPv4-mapped IPv6
    ) {
        return true;
    }

    // 4. IPv4 Checks (Including Obfuscation Defenses)
    // We check 'ip' here to catch IPv4 even if it was wrapped in brackets
    const isIpLike = /^[\d\.xXa-f]+$/.test(ip);
    
    if (isIpLike) {
        const parts = ip.split('.');
        
        if (parts.length > 0 && parts.length <= 4) {
            const numericParts = parts.map(p => {
                if (p.toLowerCase().startsWith('0x')) return parseInt(p, 16);
                if (p.startsWith('0') && p !== '0') return parseInt(p, 8); 
                return parseInt(p, 10);
            });

            if (!numericParts.some(isNaN)) {
                let p1, p2;

                if (numericParts.length === 4) {
                    p1 = numericParts[0];
                    p2 = numericParts[1];
                } else if (numericParts.length === 1) {
                    const ipInt = numericParts[0];
                    p1 = Math.floor(ipInt / 16777216) % 256;
                    p2 = Math.floor(ipInt / 65536) % 256;
                } else {
                    return true; // Block shorthand like 127.1
                }

                if (
                    p1 === 127 || p1 === 10 || p1 === 0 || 
                    (p1 === 169 && p2 === 254) || 
                    (p1 === 192 && p2 === 168) || 
                    (p1 === 172 && (p2 >= 16 && p2 <= 31))
                ) {
                    return true;
                }
            }
        }
    }

    return false;
}