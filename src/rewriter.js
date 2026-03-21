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
        // Expose the proxy domain, target domain, and hash length globally, then inject our interceptor
        element.prepend(`
            <script>
                window.__PROXY_DOMAIN__ = "${this.proxyDomain}";
                window.__TARGET_DOMAIN__ = "${this.targetDomain}";
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
        this.targetAttributes = ['href', 'src', 'action', 'poster'];
    }

    async rewriteUrl(originalUrl) {
        try {
            if (!originalUrl || originalUrl.startsWith('data:') || originalUrl.startsWith('javascript:')) return originalUrl;
            let urlToParse = originalUrl.startsWith('//') ? 'https:' + originalUrl : originalUrl;
            
            // Added WebSocket protocol coverage
            const validProtocols = ['http://', 'https://', 'ws://', 'wss://'];
            if (validProtocols.some(protocol => urlToParse.startsWith(protocol))) {
                const urlObj = new URL(urlToParse);
                
                // Use .host instead of .hostname to retain specific port numbers
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
            // Robust, case-insensitive Regex parsing for Meta Refresh URLs
            const urlMatch = content.match(/url\s*=\s*['"]?([^'"]+)['"]?/i);
            
            if (urlMatch && urlMatch[1]) {
                const originalUrl = urlMatch[1].trim();
                const rewriter = new UniversalAliasRewriter(this.proxyDomain, this.hashLength);
                const newUrl = await rewriter.rewriteUrl(originalUrl);
                
                // Replace the old URL with the new proxied URL, preserving the original delay
                const newContent = content.replace(urlMatch[0], `url=${newUrl}`);
                element.setAttribute('content', newContent);
            }
        }
    }
}

export function injectHTMLRewriter(response, proxyDomain, targetDomain, hashLength = 32) {
    return new HTMLRewriter()
        .on('head', new HeadInjector(proxyDomain, targetDomain, hashLength))
        .on('a, img, script, link, form, video, source, iframe', new UniversalAliasRewriter(proxyDomain, hashLength))
        .on('meta[http-equiv="refresh"]', new MetaRefreshRewriter(proxyDomain, hashLength))
        .transform(response);
}