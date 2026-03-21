import * as acorn from 'acorn';
import { generate } from 'astring';

/**
 * V2 Edge Proxy - Client-Side Interceptor & Worker Patcher
 * Injected into the <head> of every proxied page.
 */
class ProxyInterceptor {
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

    getWorkerSandbox() {
        return `
            const __proxyDomain = '${this.proxyDomain}';
            self.__PROXY_HASH_LENGTH__ = ${this.hashLength};
            const __syncHash = function ${this.syncHash.toString()};
            
            function __createPiggybackUrl(originalUrlStr) {
                try {
                    if (originalUrlStr.startsWith('/') || originalUrlStr.startsWith('.')) return originalUrlStr;
                    const url = new URL(originalUrlStr, self.location.href);
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
            self.__proxyImportScripts = function(...urls) { return importScripts(...urls.map(u => __createPiggybackUrl(u))); };
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

    rewriteWorkerCode(rawText) {
        try {
            // 1. Parse into Abstract Syntax Tree
            const ast = acorn.parse(rawText, { ecmaVersion: 'latest', sourceType: 'script' });

            // 2. Helper to statically evaluate string concatenations (e.g., 'fe' + 'tch')
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

            // 3. Ultra-lightweight recursive AST Walker
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

            // 4. Traverse and Mutate Nodes
            walk(ast, (node) => {
                // A. Direct Calls / New Instances (e.g., fetch(), new WebSocket())
                if ((node.type === 'CallExpression' || node.type === 'NewExpression') && node.callee.type === 'Identifier') {
                    if (TARGETS[node.callee.name]) {
                        node.callee.name = TARGETS[node.callee.name];
                    }
                }
                
                // B. Non-computed Property Access (e.g., self.fetch)
                if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
                    if (TARGETS[node.property.name]) {
                        node.property.name = TARGETS[node.property.name];
                    }
                }

                // C. Computed/Obfuscated Property Access (e.g., self['fe' + 'tch'])
                if (node.type === 'MemberExpression' && node.computed) {
                    const propVal = evaluateStringConcat(node.property);
                    if (propVal && TARGETS[propVal]) {
                        // Mutate the computed property into a static string literal of our proxy function
                        node.property = { type: 'Literal', value: TARGETS[propVal], raw: `'${TARGETS[propVal]}'` };
                    }
                }

                // D. Specific OS-Level Mitigations (clients.openWindow, registration.showNotification)
                if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
                    const propName = node.callee.property.name || evaluateStringConcat(node.callee.property);
                    if (propName === 'openWindow') {
                        node.callee = { type: 'Identifier', name: '__proxyOpenWindow' };
                    } else if (propName === 'showNotification') {
                        node.callee = { type: 'Identifier', name: '__proxyShowNotification' };
                    }
                }
            });

            // 5. Generate and return the newly secured script
            return generate(ast);

        } catch (e) {
            console.warn("V2 Proxy - AST Parsing Failed, falling back to Regex", e);
            // Fallback for broken/invalid syntax that might crash Acorn
            return rawText
                .replace(/\bfetch\s*\(/g, 'self.__proxyFetch(')
                .replace(/\bnew\s+WebSocket\s*\(/g, 'new self.__proxyWebSocket(')
                .replace(/\bnew\s+XMLHttpRequest\s*\(/g, 'new self.__proxyXMLHttpRequest(')
                .replace(/\bnew\s+EventSource\s*\(/g, 'new self.__proxyEventSource(')
                .replace(/\bimportScripts\s*\(/g, 'self.__proxyImportScripts(')
                .replace(/\bclients\.openWindow\s*\(/g, 'self.__proxyOpenWindow(')
                .replace(/\b(?:self\.)?registration\.showNotification\s*\(/g, 'self.__proxyShowNotification(');
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

        // Patch window.open for SSO popups and external links
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
            const originalRegister = navigator.serviceWorker.register;
            navigator.serviceWorker.register = async function(scriptURL, options) {
                try {
                    const response = await originalFetch(self.createPiggybackUrl(scriptURL));
                    let swText = self.rewriteWorkerCode(await response.text());
                    const blobUrl = URL.createObjectURL(new Blob([self.getWorkerSandbox() + '\n' + swText], { type: 'application/javascript' }));
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
                        realWorker = new OriginalWorker(URL.createObjectURL(new Blob([self.getWorkerSandbox() + '\n' + text], { type: 'application/javascript' })), options);
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

                // Queue or pass along messages while fetching
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
                        const blobUrl = URL.createObjectURL(new Blob([self.getWorkerSandbox() + '\n' + text], { type: 'application/javascript' }));
                        
                        realWorker = new OriginalSharedWorker(blobUrl, options);
                        realWorker.port.start();

                        // Pipe responses back to the original calling window
                        realWorker.port.addEventListener('message', (e) => {
                            channel.port2.postMessage(e.data);
                        });
                        
                        if (proxyWorker.onerror) {
                            realWorker.onerror = proxyWorker.onerror;
                        }

                        // Send any queued messages
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

        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function(state, unused, url) {
            if (url) url = interceptor.createPiggybackUrl(url.toString());
            return originalPushState.call(this, state, unused, url);
        };
        history.replaceState = function(state, unused, url) {
            if (url) url = interceptor.createPiggybackUrl(url.toString());
            return originalReplaceState.call(this, state, unused, url);
        };
        
        console.log(`🛡️ V2 Proxy - Location Spoofed: ${targetDomain}`);
    }

    // Phase 5: Cross-Origin Iframe & SSO Patches
    applyPostMessageSpoofing() {
        const self = this;

        // 1. Intercept Outbound: Translate targetOrigin to our Proxy Hash
        const originalPostMessage = Window.prototype.postMessage;
        Window.prototype.postMessage = function(message, targetOrigin, transfer) {
            let proxiedOrigin = targetOrigin;
            
            // We only modify specific targeted origins, ignoring '*' or '/'
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

        // 2. Intercept Inbound: Spoof MessageEvent.origin back to the Real Domain
        const originalOriginGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin')?.get;
        if (originalOriginGetter) {
            Object.defineProperty(MessageEvent.prototype, 'origin', {
                get: function() {
                    const realOrigin = originalOriginGetter.call(this);
                    
                    // If the incoming message came from one of our proxy alias subdomains
                    if (realOrigin && typeof realOrigin === 'string' && realOrigin.endsWith(self.proxyDomain)) {
                        try {
                            // Best-effort reverse lookup: If the sending window is accessible within 
                            // the proxy environment, read its injected target domain directly!
                            if (this.source && this.source.__TARGET_DOMAIN__) {
                                return 'https://' + this.source.__TARGET_DOMAIN__;
                            }
                        } catch (e) {
                            // DOMException: Cross-Origin Read Blocking (Expected behavior for strict browsers)
                        }
                    }
                    return realOrigin;
                }
            });
        }

        console.log("🛡️ V2 Proxy - postMessage & SSO Flows Patched");
    }
}

// Ensure dynamic initialization with a fallback of 32 if the server hasn't injected it
const hashConfigLength = window.__PROXY_HASH_LENGTH__ || 32;
const interceptor = new ProxyInterceptor(window.__PROXY_DOMAIN__, hashConfigLength);

interceptor.applyMainThreadPatches();
interceptor.applyLocationSpoofing();
interceptor.applyPostMessageSpoofing();