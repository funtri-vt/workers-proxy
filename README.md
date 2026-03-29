# 🌐 Workers Edge Proxy

**Workers Edge Proxy** is a secure, blazing-fast web proxy built entirely on the Cloudflare Workers serverless edge. 

By rethinking traditional proxy architecture, it leverages dynamic wildcard DNS routing to enforce strict Same-Origin Policy (SOP) isolation. Session state, cookies, and local storage are locked safely at the edge using Cloudflare D1 (SQLite) and R2 (Object Storage), ensuring client-side scripts never touch sensitive credentials. Protected by Cloudflare Zero Trust, it allows authenticated users to seamlessly browse the modern web without compromising native browser sandboxing.

---

## ✨ Core Architecture & Features

* **Dynamic SOP Sandboxing:** Uses deterministic configurable-length hash subdomains (via wildcard DNS) to route and isolate every proxied target. This perfectly preserves native browser security boundaries and prevents cross-site data leakage.
* **Edge-Native Session Vault:** * **Cookies (Cloudflare D1):** Strips `Set-Cookie` headers from upstream responses and securely stores session state in SQL. Cookies are injected server-side on outbound requests, keeping them completely invisible to the client's browser.
  * **Local State (Cloudflare R2):** Intercepts and syncs `localStorage` and `sessionStorage` to secure R2 buckets, preventing cross-origin DOM leaks.
  * **Performance (Cloudflare KV):** Caches system configurations and routing hashes for lightning-fast edge resolution.
* **Streaming AST Rewriter:** Modifies HTML and JavaScript on the fly using Cloudflare's `HTMLRewriter` and custom AST parsing to rewrite URLs, inject interceptors, and proxy external assets before they even reach the browser.
* **Dual-Layer Client Interception:** * **DOM Interceptor:** Injects a secure, monkey-patched payload into target pages to wrap native APIs like `fetch`, `XMLHttpRequest`, and `document.cookie`.
  * **Service Worker Fallback:** Acts as the ultimate safety net to catch and rewrite background networking requests that the AST rewriter couldn't catch.
* **Zero Trust Integration:** Natively protected behind Cloudflare Access, binding isolated sessions to cryptographically verified user identities.
* **Admin Dashboard:** Features a built-in `/__admin` interface for managing database configurations, clearing caches, and running transaction-safe, chunked database migrations without hitting Worker timeout limits.

---

## 🛠 Prerequisites

To deploy this project, you will need:
* A Cloudflare account with **Workers** enabled.
* A dedicated domain with **wildcard DNS** capabilities (e.g., `*.your-proxy.com`).
* **Cloudflare D1** initialized for SQLite storage.
* **Cloudflare R2** initialized for local storage syncing.
* **Cloudflare KV** initialized for configuration caching.
* Node.js (v18+) and `npm` installed locally.

---

## 🚀 Quick Start / Deployment

1. **Clone the repository:**
   ```bash
   git clone https://github.com/funtri-vt/workers-proxy
   cd workers-edge-proxy
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Wrangler:**
   Update your `wrangler.toml` file with your specific Cloudflare Account ID, Zone ID, and the bindings for your D1 database, R2 bucket, and KV namespace.

4. **Local Testing:**
   You can emulate the entire edge environment (including D1 and R2) locally using Miniflare:
   ```bash
   npm run test      # Run the Vitest test suite
   npx wrangler dev  # Start the local emulator
   ```

5. **Deploy to Cloudflare:**
   ```bash
   npx wrangler deploy
   ```

---

## 🤝 Contributing

We welcome contributions from the community! Because this project acts as a dynamic security sandbox, we have specific guidelines for testing changes to the AST rewriter and Service Worker. 

Please read our [Contributing Guidelines](CONTRIBUTING.md) before submitting a Pull Request.

## 🔒 Security

Security is the top priority for this proxy. If you believe you have found a vulnerability, SOP bypass, or session leak, please read our [Security Policy](SECURITY) for instructions on how to securely report it. **Please do not open public issues for security vulnerabilities.**

---

## 📜 License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. 

Any enhancements, modifications, or network deployments of this proxy must remain open-source and available to the community under the same terms. See the [LICENSE](LICENSE) file for more details.
