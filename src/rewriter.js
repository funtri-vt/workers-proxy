async function generateDomainHash(domain, hashLength = 32) {
    const data = new TextEncoder().encode(domain);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, hashLength);
}

class HeadInjector {
    constructor(proxyDomain, targetDomain, hashLength) {
        this.proxyDomain = proxyDomain;
        this.targetDomain = targetDomain;
        this.hashLength = hashLength;
    }
    
    element(element) {
        // FIXED: Using JSON.stringify() to guarantee safe escaping of variables into JS space
        element.prepend(`
            <script>
                window.__PROXY_DOMAIN__ = ${JSON.stringify(this.proxyDomain)};
                window.__TARGET_DOMAIN__ = ${JSON.stringify(this.targetDomain)};
                window.__PROXY_HASH_LENGTH__ = ${this.hashLength};
            </script>
            <script src="/__proxy/interceptor.js"></script>
        `, { html: true });
    }
}

class UniversalAliasRewriter {
    constructor(proxyDomain, hashLength) {
        this.proxyDomain = proxyDomain;
        this.hashLength = hashLength;
        // ADDED: formaction to catch modern form overrides
        this.targetAttributes = ['href', 'src', 'action', 'poster', 'formaction'];
    }

    async rewriteUrl(originalUrl) {
        try {
            if (!originalUrl) return originalUrl;
            
            // FIXED: Normalize before checking for blacklisted schemes
            const normalizedUrl = originalUrl.trim().toLowerCase();
            if (normalizedUrl.startsWith('data:') || normalizedUrl.startsWith('javascript:') || normalizedUrl.startsWith('mailto:')) {
                return originalUrl; 
            }

            let urlToParse = originalUrl.startsWith('//') ? 'https:' + originalUrl : originalUrl;
            
            const validProtocols = ['http://', 'https://', 'ws://', 'wss://'];
            if (validProtocols.some(protocol => urlToParse.toLowerCase().startsWith(protocol))) {
                const urlObj = new URL(urlToParse);
                
                const targetDomain = urlObj.host;
                if (targetDomain.endsWith(this.proxyDomain)) return originalUrl;

                const hash = await generateDomainHash(targetDomain, this.hashLength);
                const proxyUrl = new URL(urlObj.pathname + urlObj.search + urlObj.hash, `https://${hash}.${this.proxyDomain}`);
                proxyUrl.searchParams.set('__ptarget', btoa(targetDomain));
                return proxyUrl.toString();
            }
            return originalUrl; 
        } catch (e) { return originalUrl; }
    }

    async element(element) {
        for (const attr of this.targetAttributes) {
            const val = element.getAttribute(attr);
            if (val) {
                const newUrl = await this.rewriteUrl(val);
                if (newUrl !== val) element.setAttribute(attr, newUrl);
            }
        }

        // ADDED: Special handling for srcset, which can contain multiple URLs
        const srcset = element.getAttribute('srcset');
        if (srcset) {
            const parts = srcset.split(',');
            const rewrittenParts = await Promise.all(parts.map(async (part) => {
                const [url, size] = part.trim().split(/\s+/);
                if (!url) return part;
                const newUrl = await this.rewriteUrl(url);
                return size ? `${newUrl} ${size}` : newUrl;
            }));
            element.setAttribute('srcset', rewrittenParts.join(', '));
        }
    }
}

class MetaRefreshRewriter {
    constructor(proxyDomain, hashLength) {
        this.proxyDomain = proxyDomain;
        this.hashLength = hashLength;
    }
    
    async element(element) {
        const content = element.getAttribute('content');
        if (content) {
            // FIXED: Regex updated to better handle unquoted URLs followed by semicolons
            const urlMatch = content.match(/url\s*=\s*['"]?([^'";]+)['"]?/i);
            
            if (urlMatch && urlMatch[1]) {
                const originalUrl = urlMatch[1].trim();
                const rewriter = new UniversalAliasRewriter(this.proxyDomain, this.hashLength);
                const newUrl = await rewriter.rewriteUrl(originalUrl);
                
                // Replace safely
                const newContent = content.replace(originalUrl, newUrl);
                element.setAttribute('content', newContent);
            }
        }
    }
}

export function injectHTMLRewriter(response, proxyDomain, targetDomain, hashLength = 32) {
    return new HTMLRewriter()
        .on('head', new HeadInjector(proxyDomain, targetDomain, hashLength))
        // ADDED: button to catch formactions
        .on('a, img, script, link, form, button, input, video, source, iframe', new UniversalAliasRewriter(proxyDomain, hashLength))
        .on('meta[http-equiv="refresh"]', new MetaRefreshRewriter(proxyDomain, hashLength))
        .transform(response);
}