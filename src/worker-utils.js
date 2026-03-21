export function isInternalTarget(domain) {
    // 1. Fail-secure on missing or invalid input
    if (!domain || typeof domain !== 'string') return true;

    let hostname;
    try {
        // Force a protocol so the URL parser correctly maps hostname and ports
        const urlString = domain.includes('://') ? domain : `http://${domain}`;
        const urlObj = new URL(urlString);
        hostname = urlObj.hostname.toLowerCase();
    } catch (e) {
        // If it can't be parsed as a valid URL, block it
        return true; 
    }

    // 2. Block known local TLDs and localhost
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        return true;
    }

    // 3. IPv6 Checks (URL parser automatically removes brackets like '[::1]' -> '::1')
    if (
        hostname === '::1' || // Loopback
        hostname.startsWith('fc') || hostname.startsWith('fd') || // Unique Local Address
        hostname.startsWith('fe8') || hostname.startsWith('fe9') || // Link-local
        hostname.startsWith('fea') || hostname.startsWith('feb') || // Link-local
        hostname.startsWith('::ffff:') // IPv4-mapped IPv6
    ) {
        return true;
    }

    // 4. IPv4 Checks (Including Obfuscation Defenses)
    // If the hostname consists only of numbers, dots, and hex chars, evaluate it as an IP
    const isIpLike = /^[\d\.xXa-f]+$/.test(hostname);
    
    if (isIpLike) {
        const parts = hostname.split('.');
        
        // Prevent out-of-bounds array parsing
        if (parts.length > 0 && parts.length <= 4) {
            
            // Parse parts handling Hex (0x), Octal (0 prefix), and Decimal
            const numericParts = parts.map(p => {
                if (p.toLowerCase().startsWith('0x')) return parseInt(p, 16);
                if (p.startsWith('0') && p !== '0') return parseInt(p, 8); 
                return parseInt(p, 10);
            });

            // If everything parsed to a valid number
            if (!numericParts.some(isNaN)) {
                let p1, p2;

                if (numericParts.length === 4) {
                    p1 = numericParts[0];
                    p2 = numericParts[1];
                } else if (numericParts.length === 1) {
                    // Handle single integer IP (e.g., 2130706433 -> 127.0.0.1)
                    // Math.floor logic correctly extracts the first two octets
                    const ipInt = numericParts[0];
                    p1 = Math.floor(ipInt / 16777216) % 256;
                    p2 = Math.floor(ipInt / 65536) % 256;
                } else {
                    // Block shorthand formats (e.g., 127.1) entirely just to be safe
                    return true; 
                }

                if (
                    p1 === 127 || p1 === 10 || p1 === 0 || // Loopback, Class A, 0.0.0.0
                    (p1 === 169 && p2 === 254) || // Link-local
                    (p1 === 192 && p2 === 168) || // Class C
                    (p1 === 172 && (p2 >= 16 && p2 <= 31)) // Class B
                ) {
                    return true;
                }
            }
        }
    }

    return false;
}