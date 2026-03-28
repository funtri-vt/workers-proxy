# **Contributing to the V2 Edge Proxy**

First off, thank you for considering contributing to this project\! Building a secure, edge-native proxy is a massive undertaking, and community contributions are what make open-source software great.

Because this project acts as a dynamic Same-Origin Policy (SOP) sandbox and handles raw session data, we have a few guidelines to ensure that new features and bug fixes maintain the security and stability of the proxy.

## **🛠 Local Development Setup**

This project is built on Cloudflare Workers, utilizing D1 (SQL), R2 (Storage), and KV. We use wrangler for local emulation and deployment.

### **Prerequisites**

* Node.js (v18 or later recommended)  
* npm or pnpm  
* A Cloudflare account (for deployment)

### **1\. Install Dependencies**

npm install

### **2\. Run the Local Emulator**

To test the proxy locally, you can use Wrangler's development server. It will automatically emulate the D1 database and R2 buckets using Miniflare.

npx wrangler dev

*(Note: Service Workers require a secure context. wrangler dev running on localhost fulfills this requirement for local testing).*

## **🧪 Testing Guidelines**

We use **Vitest** paired with the @cloudflare/vitest-pool-workers package to run integration and unit tests within a true Worker environment.

### **Running Tests**

Before submitting any Pull Request, you **must** ensure the test suite passes:

npm run test

### **Writing New Tests**

If you are adding a new feature or fixing a bug, please include tests\! Pay special attention to:

1. **The AST Rewriter (src/rewriter.js):** If you modify how HTML or JavaScript is parsed and rewritten, you must add test cases to tests/rewriter.test.js covering both the expected behavior and potential edge cases (e.g., malformed HTML, heavily minified JS).  
2. **Database Migrations:** If you alter the D1 schema, ensure you test the migration paths and include boundary tests (like the 200 MAX\_BATCH limit in the admin API).  
3. **Service Worker / Interceptor:** Changes to client-side routing should be manually tested across major browsers (Chrome, Firefox, Safari) since Service Worker lifecycles behave differently across engines.

## **🏗 Architecture Overview**

If you are new to the codebase, here is where everything lives:

* **src/index.js**: The main Cloudflare Worker router. Handles authentication, routing, D1/R2 state syncing, and the Admin API.  
* **src/rewriter.js**: The streaming HTML/JS modifier. Injects our interceptors and rewrites URLs on the fly using Cloudflare's HTMLRewriter.  
* **src/client-interceptor.js**: The client-side payload injected into target pages. Wraps native APIs like fetch, XMLHttpRequest, and document.cookie.  
* **src/proxy-sw.js**: The Service Worker. Acts as the ultimate fallback to catch network requests initiated by the browser that the AST rewriter couldn't catch.  
* **src/admin.html**: The UI for the proxy dashboard.

## **🚀 Submitting a Pull Request**

1. **Fork the repository** and create your branch from main.  
2. **Write clear, concise commit messages.**  
3. **Run the test suite** (npm run test) and ensure all tests pass.  
4. **Update documentation** if you are adding a new feature or changing an existing API.  
5. **Open a Pull Request\!** Please describe the problem you are solving, the approach you took, and any breaking changes.

## **📜 License & Contributions**

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

By contributing to this repository, you agree that your contributions will be licensed under its AGPL-3.0 license. This ensures that any enhancements to the proxy remain open and available to the community.