import * as acorn from 'acorn';
import { generate } from 'astring';

/**
 * V3 Environment Bootstrapper: Cookie Synchronization
 * This must run before any upstream JS executes.
 */

(function initCookieSandbox() {
    // 1. Save the original descriptor just in case we need native behavior internally
    const originalCookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
                                     Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');

    // 2. We will maintain a local cache so getters are synchronous (SPAs expect instant reads)
    // In reality, you'd want the Hypervisor to pass the initial server-side cookies here on load.
    let localCookieCache = document.cookie; // Fallback to whatever is currently there

    // 3. Override the prototype
    Object.defineProperty(document, 'cookie', {
        configurable: true,
        enumerable: true,
        
        // GETTER: Return the synced state
        get: function() {
            // SPAs read cookies frequently. Returning our synced cache.
            return localCookieCache;
        },

        // SETTER: Intercept mutations
        set: function(val) {
            if (!val) return;

            // 1. Parse the basic key=value from the string (ignoring path/domain/expires for the local cache)
            const cookieParts = val.split(';');
            const primaryKvp = cookieParts[0].trim(); // e.g., "theme=dark"
            const [cKey, ...cValParts] = primaryKvp.split('=');
            const cVal = cValParts.join('='); // Handle edge cases where value has an '='

            // 2. Update our local cache so immediate subsequent gets() are accurate
            // (A very basic cookie string builder logic)
            const currentCookies = localCookieCache.split(';').map(c => c.trim()).filter(Boolean);
            const existingIndex = currentCookies.findIndex(c => c.startsWith(cKey + '='));
            
            if (existingIndex > -1) {
                currentCookies[existingIndex] = `${cKey}=${cVal}`;
            } else {
                currentCookies.push(`${cKey}=${cVal}`);
            }
            localCookieCache = currentCookies.join('; ');

            // 3. SYNC TO SERVER (D1 Vault)
            // Fire and forget fetch to our Edge Worker to update the vault
            syncCookieToEdge(val);

            // Optional: Still pass to the native setter if we want the browser to hold it for this domain
            if (originalCookieDescriptor && originalCookieDescriptor.set) {
                originalCookieDescriptor.set.call(this, val);
            }
        }
    });

    /**
     * Sends the raw Set-Cookie string to the Cloudflare Worker
     * The Worker parses it and upserts into the D1 `session_cookies` table.
     */
    function syncCookieToEdge(rawCookieString) {
        // We use our dedicated internal proxy endpoint
        fetch('/__proxy/api/cookies', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                // The worker will know the user_id and target_domain context 
                // implicitly from the edge route / jwt
                raw_cookie: rawCookieString,
                url: window.location.href 
            })
        }).catch(err => {
            console.error("🛡️ V3 Proxy - Failed to sync client cookie to vault:", err);
        });
    }

    console.log("🛡️ V3 Proxy - Document.cookie intercepted and synced to Edge Vault.");
})();

/**
 * V2 Edge Proxy - Client-Side Interceptor & Worker Patcher
 * Injected into the <head> of every proxied page.
 */
export class ProxyInterceptor {
    constructor(proxyDomain, hashLength = 32) {
        this.proxyDomain = proxyDomain;
        this.hashLength = hashLength;
        
        // Expose globally so syncHash can access it without 'this' context (important for Worker sandboxing)
        if (typeof window !== 'undefined') {
            window.__PROXY_HASH_LENGTH__ = this.hashLength;
        }
    }

    // Pure, zero-dependency Synchronous SHA-256 with Two-Tier Caching
    syncHash(ascii) {
        const globalScope = typeof window !== 'undefined' ? window : self;
        
        globalScope.__hashCache = globalScope.__hashCache || {};
        if (globalScope.__hashCache[ascii]) return globalScope.__hashCache[ascii];

        function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
        let mathPow = Math.pow, maxWord = mathPow(2, 32), lengthProperty = 'length';
        let i, j, result = '', words = [], asciiBitLength = ascii[lengthProperty] * 8;

        if (!globalScope.__sha256Constants) {
            let initHash = [], k = [], primeCounter = 0, isComposite = {};
            for (let candidate = 2; primeCounter < 64; candidate++) {
                if (!isComposite[candidate]) {
                    for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
                    initHash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
                    k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
                }
            }
            globalScope.__sha256Constants = { initHash, k };
        }

        let hash = globalScope.__sha256Constants.initHash.slice();
        let k = globalScope.__sha256Constants.k;

        ascii += '\x80';
        while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
        for (i = 0; i < ascii[lengthProperty]; i++) {
            j = ascii.charCodeAt(i);
            words[i >> 2] |= j << ((3 - i % 4) * 8);
        }
        words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
        words[words[lengthProperty]] = (asciiBitLength);
        
        for (j = 0; j < words[lengthProperty];) {
            let w = words.slice(j, j += 16), oldHash = hash;
            hash = hash.slice(0, 8);
            for (i = 0; i < 64; i++) {
                let w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
                let temp1 = hash[7] + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) + ((e & hash[5]) ^ ((~e) & hash[6])) + k[i] + (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) | 0);
                let temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
                hash = [(temp1 + temp2) | 0].concat(hash);
                hash[4] = (hash[4] + temp1) | 0;
            }
            for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
        }
        for (i = 0; i < 8; i++) {
            for (j = 3; j + 1; j--) {
                let b = (hash[i] >> (j * 8)) & 255;
                result += ((b < 16) ? 0 : '') + b.toString(16);
            }
        }
        
        // Dynamically slice based on configured hash length (default 32)
        const hashLen = globalScope.__PROXY_HASH_LENGTH__ || 32;
        const finalHash = result.substring(0, hashLen);
        globalScope.__hashCache[ascii] = finalHash; 
        return finalHash; 
    }

    createPiggybackUrl(originalUrlStr) {
        try {
            if (originalUrlStr.startsWith('/') || originalUrlStr.startsWith('.')) return originalUrlStr;
            const url = new URL(originalUrlStr, window.location.href);
            if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return originalUrlStr;

            const targetDomain = url.host;
            if (targetDomain.endsWith(this.proxyDomain)) return originalUrlStr; 

            const aliasHash = this.syncHash(targetDomain);
            const encodedDomain = btoa(targetDomain);

            const proxyProtocol = url.protocol.startsWith('ws') ? 'wss:' : 'https:';
            const proxyUrl = new URL(url.pathname + url.search + url.hash, `${proxyProtocol}//${aliasHash}.${this.proxyDomain}`);
            proxyUrl.searchParams.set('__ptarget', encodedDomain);
            
            return proxyUrl.toString();
        } catch (e) { return originalUrlStr; }
    }

    getWorkerSandbox(originalScriptUrl) {
        return `
            const __proxyDomain = '${this.proxyDomain}';
            self.__PROXY_HASH_LENGTH__ = ${this.hashLength};
            const __syncHash = function ${this.syncHash.toString()};
            const __originalScriptUrl = '${originalScriptUrl}';
            
            // --- THE LOCATION SPOOFER ---
            const __mockLocationUrl = new URL(__originalScriptUrl, self.location.href);
            const __proxyLocation = new Proxy(__mockLocationUrl, {
                get: function(target, prop) {
                    if (prop === 'toString') return () => target.href;
                    if (typeof target[prop] === 'function') return target[prop].bind(target);
                    return target[prop];
                },
                set: function(target, prop, value) {
                    if (prop === 'href') {
                        target.href = __createPiggybackUrl(value);
                        return true;
                    }
                    target[prop] = value;
                    return true;
                }
            });
            const location = __proxyLocation;
            
            function __createPiggybackUrl(originalUrlStr) {
                try {
                    if (originalUrlStr.startsWith('/') || originalUrlStr.startsWith('.')) return originalUrlStr;
                    // FIX: Resolving relative URLs against the original script context, not the blob URL
                    const url = new URL(originalUrlStr, __originalScriptUrl);
                    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return originalUrlStr;
                    
                    const targetDomain = url.host;
                    if (targetDomain.endsWith(__proxyDomain)) return originalUrlStr;
                    
                    const aliasHash = __syncHash(targetDomain);
                    const proxyProtocol = url.protocol.startsWith('ws') ? 'wss:' : 'https:';
                    const proxyUrl = new URL(url.pathname + url.search + url.hash, proxyProtocol + '//' + aliasHash + '.' + __proxyDomain);
                    proxyUrl.searchParams.set('__ptarget', btoa(targetDomain));
                    return proxyUrl.toString();
                } catch (e) { return originalUrlStr; }
            }
            
            self.__proxyFetch = function(resource, options) {
                if (resource instanceof Request) return fetch(new Request(__createPiggybackUrl(resource.url), resource), options);
                return fetch(__createPiggybackUrl(resource), options);
            };
            self.__proxyWebSocket = class extends WebSocket { constructor(url, protocols) { super(__createPiggybackUrl(url), protocols); } };
            self.__proxyXMLHttpRequest = class extends XMLHttpRequest { open(method, url, async, user, password) { return super.open(method, __createPiggybackUrl(url), async, user, password); } };
            self.__proxyEventSource = class extends EventSource { constructor(url, eventSourceInitDict) { super(__createPiggybackUrl(url), eventSourceInitDict); } };
            
            // --- IMPORT SCRIPTS SHADOWING ---
            // We must shadow the global importScripts directly so that nested
            // imported scripts also use the piggybacked URLs automatically,
            // without relying exclusively on the AST rewriter for every layer.
            const __originalImportScripts = self.importScripts;
            self.__proxyImportScripts = function(...urls) { 
                return __originalImportScripts.apply(self, urls.map(u => __createPiggybackUrl(u))); 
            };
            self.importScripts = self.__proxyImportScripts;

            self.__proxyOpenWindow = function(url) { if (self.clients && self.clients.openWindow) return self.clients.openWindow(__createPiggybackUrl(url)); };
            self.__proxyShowNotification = function(title, options) {
                if (options) {
                    if (options.icon) options.icon = __createPiggybackUrl(options.icon);
                    if (options.image) options.image = __createPiggybackUrl(options.image);
                    if (options.badge) options.badge = __createPiggybackUrl(options.badge);
                }
                return self.registration.showNotification(title, options);
            };
        `;
    }

    // --- NEW: Universal Regex Pipeline for JS/HTML ---
    applyRegexPipeline(rawText) {
        if (!rawText || typeof rawText !== 'string') return rawText;
        return rawText
            // Phase 2: Explicit property access
            .replace(/\bwindow\.location\b/g, 'window.__proxyLocation')
            .replace(/\bdocument\.location\b/g, 'document.__proxyLocation')
            .replace(/\btop\.location\b/g, 'top.__proxyLocation')
            // Phase 3: The "Naked" Location Problem
            .replace(/(?<![a-zA-Z0-9_$])(?<!\.)\blocation\b(?=\s*(?:\.|\[|===?|!==?|=(?!=)))/g, 'window.__proxyLocation');
    }

    rewriteWorkerCode(rawText) {
        try {
            const ast = acorn.parse(rawText, { ecmaVersion: 'latest', sourceType: 'script' });

            const evaluateStringConcat = (node) => {
                if (node.type === 'Literal') return node.value;
                if (node.type === 'BinaryExpression' && node.operator === '+') {
                    const left = evaluateStringConcat(node.left);
                    const right = evaluateStringConcat(node.right);
                    if (typeof left === 'string' && typeof right === 'string') return left + right;
                }
                return null;
            };

            const TARGETS = {
                'fetch': '__proxyFetch',
                'WebSocket': '__proxyWebSocket',
                'XMLHttpRequest': '__proxyXMLHttpRequest',
                'EventSource': '__proxyEventSource',
                'importScripts': '__proxyImportScripts'
            };

            const walk = (node, visitor) => {
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node)) {
                    node.forEach(child => walk(child, visitor));
                    return;
                }
                visitor(node);
                for (const key in node) {
                    if (key !== 'loc' && key !== 'range' && Object.prototype.hasOwnProperty.call(node, key)) {
                        walk(node[key], visitor);
                    }
                }
            };

            walk(ast, (node) => {
                if ((node.type === 'CallExpression' || node.type === 'NewExpression') && node.callee.type === 'Identifier') {
                    if (TARGETS[node.callee.name]) {
                        node.callee.name = TARGETS[node.callee.name];
                    }
                }
                
                if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
                    if (TARGETS[node.property.name]) {
                        node.property.name = TARGETS[node.property.name];
                    }
                    
                    if (node.object.name === 'self' && node.property.name === 'location') {
                        Object.keys(node).forEach(key => delete node[key]);
                        node.type = 'Identifier';
                        node.name = '__proxyLocation';
                    }
                }

                if (node.type === 'MemberExpression' && node.computed) {
                    const propVal = evaluateStringConcat(node.property);
                    if (propVal && TARGETS[propVal]) {
                        node.property = { type: 'Literal', value: TARGETS[propVal], raw: `'${TARGETS[propVal]}'` };
                    }
                }

                if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
                    const propName = node.callee.property.name || evaluateStringConcat(node.callee.property);
                    if (propName === 'openWindow') {
                        node.callee = { type: 'Identifier', name: '__proxyOpenWindow' };
                    } else if (propName === 'showNotification') {
                        node.callee = { type: 'Identifier', name: '__proxyShowNotification' };
                    }
                }
            });

            return generate(ast);

        } catch (e) {
            console.warn("V2 Proxy - AST Parsing Failed, falling back to Regex", e);
            let patchedText = rawText
                .replace(/\bfetch\s*\(/g, 'self.__proxyFetch(')
                .replace(/\bnew\s+WebSocket\s*\(/g, 'new self.__proxyWebSocket(')
                .replace(/\bnew\s+XMLHttpRequest\s*\(/g, 'new self.__proxyXMLHttpRequest(')
                .replace(/\bnew\s+EventSource\s*\(/g, 'new self.__proxyEventSource(')
                .replace(/\bimportScripts\s*\(/g, 'self.__proxyImportScripts(')
                .replace(/\bclients\.openWindow\s*\(/g, 'self.__proxyOpenWindow(')
                .replace(/\b(?:self\.)?registration\.showNotification\s*\(/g, 'self.__proxyShowNotification(')
                .replace(/\bself\.location\b/g, '__proxyLocation');
                
            return this.applyRegexPipeline(patchedText);
        }
    }

    applyMainThreadPatches() {
        const self = this;
        const originalFetch = window.fetch;

        window.fetch = async function(input, init) {
            try {
                let url;
                let requestOptions = init || {};
                
                if (input instanceof Request) {
                    url = input.url;
                    requestOptions = {
                        method: input.method, headers: input.headers, credentials: input.credentials,
                        cache: input.cache, redirect: input.redirect, referrer: input.referrer, ...requestOptions
                    };
                    if (!input.bodyUsed && !['GET', 'HEAD'].includes(input.method.toUpperCase())) requestOptions.body = input.body;
                } else { url = input.toString(); }

                return originalFetch.call(this, self.createPiggybackUrl(url), requestOptions);
            } catch (err) { return originalFetch.call(this, input, init); }
        };

        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            try { return originalXhrOpen.call(this, method, self.createPiggybackUrl(url.toString()), ...args); } 
            catch (err) { return originalXhrOpen.call(this, method, url, ...args); }
        };

        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = function(url, protocols) { return new OriginalWebSocket(self.createPiggybackUrl(url), protocols); };

        const originalWindowOpen = window.open;
        window.open = function(url, target, windowFeatures) {
            try {
                const proxiedUrl = url ? self.createPiggybackUrl(url.toString()) : url;
                return originalWindowOpen.call(this, proxiedUrl, target, windowFeatures);
            } catch (err) {
                return originalWindowOpen.call(this, url, target, windowFeatures);
            }
        };

        // Service Worker Patching
        if (navigator.serviceWorker) {
            // Save the original register specifically for our own root SW later
            this._originalSwRegister = navigator.serviceWorker.register;
            const originalRegister = navigator.serviceWorker.register;
            
            navigator.serviceWorker.register = async function(scriptURL, options) {
                try {
                    const response = await originalFetch(self.createPiggybackUrl(scriptURL));
                    let swText = self.rewriteWorkerCode(await response.text());
                    const blobUrl = URL.createObjectURL(new Blob([self.getWorkerSandbox(scriptURL) + '\n' + swText], { type: 'application/javascript' }));
                    const defaultScope = new URL(scriptURL, window.location.href).pathname.replace(/\/[^\/]*$/, '/');
                    return originalRegister.call(this, blobUrl, { ...options, scope: options?.scope || defaultScope });
                } catch (err) { return originalRegister.call(this, scriptURL, options); }
            };
        }

        // Dedicated Web Worker Patching
        const OriginalWorker = window.Worker;
        if (OriginalWorker) {
            window.Worker = function(scriptURL, options) {
                const eventTarget = document.createElement('div');
                let realWorker = null, messageQueue = [];
                const proxyWorker = {
                    postMessage: (msg, transfer) => realWorker ? realWorker.postMessage(msg, transfer) : messageQueue.push({msg, transfer}),
                    terminate: () => { if (realWorker) realWorker.terminate(); proxyWorker._terminated = true; },
                    addEventListener: (t, l, o) => eventTarget.addEventListener(t, l, o),
                    removeEventListener: (t, l, o) => eventTarget.removeEventListener(t, l, o),
                    set onmessage(fn) { eventTarget.addEventListener('message', fn); },
                    set onerror(fn) { eventTarget.addEventListener('error', fn); }
                };

                (async () => {
                    try {
                        const response = await originalFetch(self.createPiggybackUrl(scriptURL));
                        let text = self.rewriteWorkerCode(await response.text());
                        if (proxyWorker._terminated) return;
                        realWorker = new OriginalWorker(URL.createObjectURL(new Blob([self.getWorkerSandbox(scriptURL) + '\n' + text], { type: 'application/javascript' })), options);
                        realWorker.onmessage = (e) => eventTarget.dispatchEvent(new MessageEvent('message', { data: e.data }));
                        realWorker.onerror = (e) => eventTarget.dispatchEvent(new ErrorEvent('error', { error: e.error, message: e.message }));
                        messageQueue.forEach(m => realWorker.postMessage(m.msg, m.transfer)); messageQueue = [];
                    } catch (err) {}
                })();
                return proxyWorker;
            };
        }

        // Shared Worker Patching
        const OriginalSharedWorker = window.SharedWorker;
        if (OriginalSharedWorker) {
            window.SharedWorker = function(scriptURL, options) {
                const channel = new MessageChannel();
                const proxyWorker = { port: channel.port1, onerror: null };
                let realWorker = null;
                let messageQueue = [];

                channel.port1.start();
                channel.port2.start();

                channel.port2.addEventListener('message', (e) => {
                    if (realWorker) {
                        realWorker.port.postMessage(e.data);
                    } else {
                        messageQueue.push(e.data);
                    }
                });

                (async () => {
                    try {
                        const response = await originalFetch(self.createPiggybackUrl(scriptURL));
                        let text = self.rewriteWorkerCode(await response.text());
                        const blobUrl = URL.createObjectURL(new Blob([self.getWorkerSandbox(scriptURL) + '\n' + text], { type: 'application/javascript' }));
                        
                        realWorker = new OriginalSharedWorker(blobUrl, options);
                        realWorker.port.start();

                        realWorker.port.addEventListener('message', (e) => {
                            channel.port2.postMessage(e.data);
                        });
                        
                        if (proxyWorker.onerror) {
                            realWorker.onerror = proxyWorker.onerror;
                        }

                        messageQueue.forEach(msg => realWorker.port.postMessage(msg));
                        messageQueue = [];
                    } catch (err) {}
                })();
                
                return proxyWorker;
            };
        }

        console.log("🛡️ V2 Proxy - Core Network & Window Opening Patched");
    }

    applyLocationSpoofing() {
        if (!window.__TARGET_DOMAIN__) return;
        const targetDomain = window.__TARGET_DOMAIN__;

        try { Object.defineProperty(document, 'domain', { get: () => targetDomain, set: () => {} }); } catch (e) {}

        const spoofedUrl = window.location.href.replace(window.location.host, targetDomain);
        try {
            Object.defineProperty(document, 'URL', { get: () => spoofedUrl });
            Object.defineProperty(document, 'documentURI', { get: () => spoofedUrl });
        } catch (e) {}

        const self = this;
        const mockLocationUrl = new URL(spoofedUrl);
        window.__proxyLocation = new Proxy(mockLocationUrl, {
            get: function(target, prop) {
                if (prop === 'toString') return () => target.href;
                if (prop === 'assign') return (url) => window.location.assign(self.createPiggybackUrl(url));
                if (prop === 'replace') return (url) => window.location.replace(self.createPiggybackUrl(url));
                if (prop === 'reload') return () => window.location.reload();
                if (typeof target[prop] === 'function') return target[prop].bind(target);
                return target[prop];
            },
            set: function(target, prop, value) {
                if (prop === 'href') {
                    window.location.href = self.createPiggybackUrl(value);
                    return true;
                }
                target[prop] = value;
                return true;
            }
        });
        document.__proxyLocation = window.__proxyLocation;

        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function(state, unused, url) {
            if (url) url = self.createPiggybackUrl(url.toString());
            return originalPushState.call(this, state, unused, url);
        };
        history.replaceState = function(state, unused, url) {
            if (url) url = self.createPiggybackUrl(url.toString());
            return originalReplaceState.call(this, state, unused, url);
        };
        
        console.log(`🛡️ V2 Proxy - Location Spoofed: ${targetDomain}`);
    }

    applyPostMessageSpoofing() {
        const self = this;

        const originalPostMessage = Window.prototype.postMessage;
        Window.prototype.postMessage = function(message, targetOrigin, transfer) {
            let proxiedOrigin = targetOrigin;
            
            if (targetOrigin && targetOrigin !== '*' && targetOrigin !== '/') {
                try {
                    const url = new URL(targetOrigin);
                    const piggybacked = self.createPiggybackUrl(url.origin);
                    proxiedOrigin = new URL(piggybacked).origin; 
                } catch (e) {
                    // Ignore malformed targetOrigins
                }
            }
            return originalPostMessage.call(this, message, proxiedOrigin, transfer);
        };

        const originalOriginGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin')?.get;
        if (originalOriginGetter) {
            Object.defineProperty(MessageEvent.prototype, 'origin', {
                get: function() {
                    const realOrigin = originalOriginGetter.call(this);
                    
                    if (realOrigin && typeof realOrigin === 'string' && realOrigin.endsWith(self.proxyDomain)) {
                        try {
                            if (this.source && this.source.__TARGET_DOMAIN__) {
                                return 'https://' + this.source.__TARGET_DOMAIN__;
                            }
                        } catch (e) {
                            // DOMException expected here for strict cross-origin policies
                        }
                    }
                    return realOrigin;
                }
            });
        }

        console.log("🛡️ V2 Proxy - postMessage & SSO Flows Patched");
    }

    // --- NEW: Register the Main Proxy Service Worker ---
    async registerRootServiceWorker(swPath = '/sw.js') {
        if (!navigator.serviceWorker) return;

        try {
            // Fetch the SW text strictly from your root domain to bypass same-origin strictness on the alias
            const rootSwUrl = `https://${this.proxyDomain}${swPath}`;
            const response = await fetch(rootSwUrl);

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const swScript = await response.text();

            // Create a blob URL to execute it legally within the current subdomain scope
            const blobUrl = URL.createObjectURL(new Blob([swScript], { type: 'application/javascript' }));

            // Use the unpatched register method so we don't accidentally run AST parsing on our OWN proxy SW!
            const realRegister = this._originalSwRegister || Object.getPrototypeOf(navigator.serviceWorker).register;
            
            const registration = await realRegister.call(navigator.serviceWorker, blobUrl, { scope: '/' });
            console.log(`🛡️ V2 Proxy - Root Service Worker Registered Successfully! Scope: ${registration.scope}`);
        } catch (error) {
            console.error('🛡️ V2 Proxy - Root Service Worker registration failed:', error);
        }
    }
}

// Ensure dynamic initialization with a fallback of 32 if the server hasn't injected it
const hashConfigLength = window.__PROXY_HASH_LENGTH__ || 32;
const interceptor = new ProxyInterceptor(window.__PROXY_DOMAIN__, hashConfigLength);

interceptor.applyMainThreadPatches();
interceptor.applyLocationSpoofing();
interceptor.applyPostMessageSpoofing();

// Fire off the proxy's own root service worker registration
// Note: You can change the path if your SW is located somewhere else (e.g., '/proxy-sw.js')
interceptor.registerRootServiceWorker('/__proxy/sw.js');
