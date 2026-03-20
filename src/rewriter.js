async function generateDomainHash(domain) {
    const data = new TextEncoder().encode(domain);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

class HeadInjector {
    constructor(proxyDomain) {
        this.proxyDomain = proxyDomain;
    }
    element(element) {
        // Expose the proxy domain globally and inject our interceptor right at the top of the <head>
        element.prepend(`
            <script>window.__PROXY_DOMAIN__ = "${this.proxyDomain}";</script>
            <script src="/__proxy/interceptor.js"></script>
        `, { html: true });
    }
}

class UniversalAliasRewriter {
    constructor(proxyDomain) {
        this.proxyDomain = proxyDomain;
        this.targetAttributes = ['href', 'src', 'action', 'poster'];
    }

    async rewriteUrl(originalUrl) {
        try {
            if (!originalUrl || originalUrl.startsWith('data:') || originalUrl.startsWith('javascript:')) return originalUrl;
            let urlToParse = originalUrl.startsWith('//') ? 'https:' + originalUrl : originalUrl;
            
            // FIX 4: Added WebSocket protocol coverage
            const validProtocols = ['http://', 'https://', 'ws://', 'wss://'];
            if (validProtocols.some(protocol => urlToParse.startsWith(protocol))) {
                const urlObj = new URL(urlToParse);
                
                // FIX 2: Use .host instead of .hostname to retain specific port numbers
                const targetDomain = urlObj.host;
                if (targetDomain.endsWith(this.proxyDomain)) return originalUrl;

                const hash = await generateDomainHash(targetDomain);
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
    constructor(proxyDomain) {
        this.proxyDomain = proxyDomain;
    }
    async element(element) {
        const content = element.getAttribute('content');
        if (content) {
            // FIX 3: Robust, case-insensitive Regex parsing for Meta Refresh URLs
            const urlMatch = content.match(/url\s*=\s*['"]?([^'"]+)['"]?/i);
            
            if (urlMatch && urlMatch[1]) {
                const originalUrl = urlMatch[1].trim();
                const rewriter = new UniversalAliasRewriter(this.proxyDomain);
                const newUrl = await rewriter.rewriteUrl(originalUrl);
                
                // Replace the old URL with the new proxied URL, preserving the original delay
                const newContent = content.replace(urlMatch[0], `url=${newUrl}`);
                element.setAttribute('content', newContent);
            }
        }
    }
}

export function injectHTMLRewriter(response, proxyDomain) {
    return new HTMLRewriter()
        .on('head', new HeadInjector(proxyDomain))
        .on('a, img, script, link, form, video, source, iframe', new UniversalAliasRewriter(proxyDomain))
        .on('meta[http-equiv="refresh"]', new MetaRefreshRewriter(proxyDomain))
        .transform(response);
}