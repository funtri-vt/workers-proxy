class ProxyInterceptor {
    constructor(proxyDomain) {
        this.proxyDomain = proxyDomain;
    }

    syncHash(ascii) {
        const env = typeof globalThis !== 'undefined' ? globalThis : self;
        env.__hashCache = env.__hashCache || {};
        if (env.__hashCache[ascii]) return env.__hashCache[ascii];

        function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
        let mathPow = Math.pow, maxWord = mathPow(2, 32), lengthProperty = 'length';
        let i, j, result = '', words = [], asciiBitLength = ascii[lengthProperty] * 8;

        if (!env.__sha256Constants) {
            let initHash = [], k = [], primeCounter = 0, isComposite = {};
            for (let candidate = 2; primeCounter < 64; candidate++) {
                if (!isComposite[candidate]) {
                    for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
                    initHash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
                    k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
                }
            }
            env.__sha256Constants = { initHash, k };
        }

        let hash = env.__sha256Constants.initHash.slice();
        let k = env.__sha256Constants.k;

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
        
        const finalOutput = result.substring(0, 16);
        env.__hashCache[ascii] = finalOutput;
        return finalOutput;
    }

    createPiggybackUrl(originalUrlStr) {
        try {
            if (!originalUrlStr || originalUrlStr.startsWith('data:') || originalUrlStr.startsWith('blob:')) return originalUrlStr;
            const url = new URL(originalUrlStr, window.location.href);
            if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return originalUrlStr;
            const targetDomain = url.hostname;
            if (targetDomain.endsWith(this.proxyDomain)) return originalUrlStr; 

            const aliasHash = this.syncHash(targetDomain);
            const proxyProtocol = url.protocol.startsWith('ws') ? 'wss:' : 'https:';
            const proxyUrl = new URL(url.pathname + url.search + url.hash, `${proxyProtocol}//${aliasHash}.${this.proxyDomain}`);
            proxyUrl.searchParams.set('__ptarget', btoa(targetDomain));
            return proxyUrl.toString();
        } catch (e) { return originalUrlStr; }
    }

    getWorkerSandbox() {
        return `
            const __proxyDomain = '${this.proxyDomain}';
            const __syncHash = function ${this.syncHash.toString()};
            function __createPiggybackUrl(originalUrlStr) {
                try {
                    if (!originalUrlStr || originalUrlStr.startsWith('data:') || originalUrlStr.startsWith('blob:')) return originalUrlStr;
                    const url = new URL(originalUrlStr, self.location.href);
                    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return originalUrlStr;
                    const targetDomain = url.hostname;
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
        `;
    }

    applyMainThreadPatches() {
        const self = this;
        const originalFetch = window.fetch;

        window.fetch = async function(resource, options) {
            if (resource instanceof Request) return originalFetch.call(this, new Request(self.createPiggybackUrl(resource.url), resource), options);
            return originalFetch.call(this, self.createPiggybackUrl(resource), options);
        };
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) { return originalXhrOpen.call(this, method, self.createPiggybackUrl(url), async, user, password); };
        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = function(url, protocols) { return new OriginalWebSocket(self.createPiggybackUrl(url), protocols); };

        if (navigator.serviceWorker) {
            const originalRegister = navigator.serviceWorker.register;
            navigator.serviceWorker.register = async function(scriptURL, options) {
                const response = await originalFetch(self.createPiggybackUrl(scriptURL));
                let swText = await response.text();
                swText = swText.replace(/\bfetch\s*\(/g, 'self.__proxyFetch(').replace(/\bnew\s+WebSocket\s*\(/g, 'new self.__proxyWebSocket(').replace(/\bnew\s+XMLHttpRequest\s*\(/g, 'new self.__proxyXMLHttpRequest(').replace(/\bnew\s+EventSource\s*\(/g, 'new self.__proxyEventSource(').replace(/\bimportScripts\s*\(/g, 'self.__proxyImportScripts(');
                const blobUrl = URL.createObjectURL(new Blob([self.getWorkerSandbox() + '\n' + swText], { type: 'application/javascript' }));
                const defaultScope = new URL(scriptURL, window.location.href).pathname.replace(/\/[^\/]*$/, '/');
                return originalRegister.call(this, blobUrl, { ...options, scope: options?.scope || defaultScope });
            };
        }

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
                    const response = await originalFetch(self.createPiggybackUrl(scriptURL));
                    let text = (await response.text()).replace(/\bfetch\s*\(/g, 'self.__proxyFetch(').replace(/\bnew\s+WebSocket\s*\(/g, 'new self.__proxyWebSocket(').replace(/\bnew\s+XMLHttpRequest\s*\(/g, 'new self.__proxyXMLHttpRequest(').replace(/\bnew\s+EventSource\s*\(/g, 'new self.__proxyEventSource(').replace(/\bimportScripts\s*\(/g, 'self.__proxyImportScripts(');
                    if (proxyWorker._terminated) return;
                    realWorker = new OriginalWorker(URL.createObjectURL(new Blob([self.getWorkerSandbox() + '\n' + text], { type: 'application/javascript' })), options);
                    realWorker.onmessage = (e) => eventTarget.dispatchEvent(new MessageEvent('message', { data: e.data }));
                    realWorker.onerror = (e) => eventTarget.dispatchEvent(new ErrorEvent('error', { error: e.error, message: e.message }));
                    messageQueue.forEach(m => realWorker.postMessage(m.msg, m.transfer)); messageQueue = [];
                })();
                return proxyWorker;
            };
        }
    }
}

// Ensure the script runs immediately upon injection
if (typeof window !== 'undefined' && window.__PROXY_DOMAIN__) {
    const interceptor = new ProxyInterceptor(window.__PROXY_DOMAIN__);
    interceptor.applyMainThreadPatches();
}