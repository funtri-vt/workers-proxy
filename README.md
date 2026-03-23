# **Workers Edge Proxy**

## This project is currently a work-in-progress and still currently (mostly) at the proof of concept stage. Expect issues or unimplemented features.

**Workers Edge Proxy** is a secure, blazing-fast web proxy built entirely on the Cloudflare Workers serverless edge. By rethinking traditional proxy architecture, it leverages dynamic wildcard DNS routing to enforce strict Same-Origin Policy (SOP) isolation. Session state and cookies are locked safely at the edge using Cloudflare D1 (SQLite), ensuring client-side scripts never touch sensitive credentials. Protected by Cloudflare Zero Trust, it allows authenticated users to seamlessly browse the modern web—complete with native WebSocket support—without compromising native browser sandboxing.

### **Core Architecture & Features**

* **Dynamic SOP Sandboxing:** Uses deterministic configurable-length hash subdomains (via wildcard DNS) to route and isolate every proxied target. This perfectly preserves native browser security boundaries and prevents cross-site data leakage.  
* **Edge-Native Cookie Vault:** Strips Set-Cookie headers from upstream responses and securely stores session state in Cloudflare D1. Cookies are injected server-side on outbound requests, keeping them completely invisible to the client's browser.  
* **Zero Trust Integration:** Natively protected behind Cloudflare Access, binding isolated SQLite sessions to cryptographically verified user identities.  
* **Advanced Client Interception:** Injects a secure, monkey-patched web worker sandbox into the DOM to seamlessly proxy background networking, including WebSockets, XMLHttpRequest, fetch, and Service Worker traffic.

### **Deployment Prerequisites**

* A Cloudflare account with Workers enabled.  
* A dedicated domain with wildcard DNS capabilities (e.g., \*.workers-proxy.com).  
* Cloudflare D1 initialized for SQLite storage.
