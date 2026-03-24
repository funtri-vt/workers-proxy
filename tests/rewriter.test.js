import { describe, it, expect } from 'vitest';
import { injectHTMLRewriter } from '../src/rewriter.js';

describe('HTMLRewriter Module', () => {
    const PROXY_DOMAIN = 'workers-proxy.com';
    const TARGET_DOMAIN = 'example.com';
    const HASH_LENGTH = 16;
    const MOCK_COOKIES = "session=123; theme=dark";

    async function rewriteAndRead(htmlString) {
        const mockResponse = new Response(htmlString, {
            headers: { 'Content-Type': 'text/html' }
        });
        
        // Pass through our rewriter
        const rewrittenResponse = injectHTMLRewriter(
            mockResponse, 
            PROXY_DOMAIN, 
            TARGET_DOMAIN, 
            MOCK_COOKIES,
            undefined,
            HASH_LENGTH
        );
        
        return await rewrittenResponse.text();
    }

    it('should inject configuration and cookies into the <head>', async () => {
        const html = `<head><title>Test</title></head>`;
        const result = await rewriteAndRead(html);
        
        expect(result).toContain(`window.__PROXY_DOMAIN__ = "${PROXY_DOMAIN}"`);
        expect(result).toContain(`window.__TARGET_DOMAIN__ = "${TARGET_DOMAIN}"`);
        expect(result).toContain(`window.__INITIAL_COOKIES__ = "${MOCK_COOKIES}"`);
        expect(result).toContain(`<script src="/__proxy/interceptor.js"></script>`);
    });

    it('should rewrite standard href and src attributes', async () => {
        const html = `<body>
            <a href="https://google.com/search?q=test">Search</a>
            <img src="https://images.example.com/pic.png" />
        </body>`;
        const result = await rewriteAndRead(html);
        
        // It should convert to aliases and append __ptarget (accounting for URL-encoded %3D padding)
        expect(result).toMatch(/href="https:\/\/[a-f0-9]{16}\.workers-proxy\.com\/search\?q=test&__ptarget=[A-Za-z0-9=%]+"/);
        expect(result).toMatch(/src="https:\/\/[a-f0-9]{16}\.workers-proxy\.com\/pic\.png\?__ptarget=[A-Za-z0-9=%]+"/);
    });

    it('should ignore data:, mailto:, and javascript: URIs', async () => {
        const html = `<body>
            <a href="mailto:admin@test.com">Email</a>
            <a href="javascript:void(0)">Click</a>
            <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=" />
        </body>`;
        const result = await rewriteAndRead(html);
        
        expect(result).toContain(`href="mailto:admin@test.com"`);
        expect(result).toContain(`href="javascript:void(0)"`);
        expect(result).toContain(`src="data:image/png;base64`);
    });

    it('should handle complex srcset attributes', async () => {
        const html = `<img srcset="https://cdn.example.com/img1.png 1x, https://cdn.example.com/img2.png 2x" />`;
        const result = await rewriteAndRead(html);
        
        // Both URLs inside the srcset should be rewritten
        expect(result).toContain('.workers-proxy.com/img1.png?__ptarget=');
        expect(result).toContain('.workers-proxy.com/img2.png?__ptarget=');
        expect(result).toContain('1x,');
        expect(result).toContain('2x"');
    });
    it('should safely rewrite attributes split across streaming chunks', async () => {
        const html = `<body>
            <a href="https://streaming.example.com/path?test=1">Chunked Link</a>
            <img src="https://streaming.example.com/image.png" />
        </body>`;
        
        // Create a ReadableStream that feeds the HTML in painfully small 2-byte chunks.
        // This guarantees that elements like <a href="..."> will be split across multiple chunks.
        let position = 0;
        const chunkSize = 2;
        const encoder = new TextEncoder();
        
        const chunkedStream = new ReadableStream({
            pull(controller) {
                if (position >= html.length) {
                    controller.close();
                    return;
                }
                const chunk = html.slice(position, position + chunkSize);
                controller.enqueue(encoder.encode(chunk));
                position += chunkSize;
            }
        });

        // Wrap the stream in a Response
        const mockResponse = new Response(chunkedStream, {
            headers: { 'Content-Type': 'text/html' }
        });
        
        // Pass through our rewriter
        const rewrittenResponse = injectHTMLRewriter(
            mockResponse, 
            PROXY_DOMAIN, 
            TARGET_DOMAIN, 
            MOCK_COOKIES,
            undefined,
            HASH_LENGTH
        );
        
        const result = await rewrittenResponse.text();
        
        // Validate that the rewriter successfully caught and rewrote the severed attributes
        expect(result).toMatch(/href="https:\/\/[a-f0-9]{16}\.workers-proxy\.com\/path\?test=1&__ptarget=[A-Za-z0-9=%]+"/);
        expect(result).toMatch(/src="https:\/\/[a-f0-9]{16}\.workers-proxy\.com\/image\.png\?__ptarget=[A-Za-z0-9=%]+"/);
        expect(result).toContain(">Chunked Link</a>");
    });
});
