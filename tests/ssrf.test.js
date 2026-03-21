import { describe, it, expect } from 'vitest'; // or 'jest'
import { isInternalTarget } from '../src/worker-utils';

describe('isInternalTarget SSRF Protection', () => {
    
    it('should allow valid, external public domains', () => {
        expect(isInternalTarget('google.com')).toBe(false);
        expect(isInternalTarget('api.github.com')).toBe(false);
        expect(isInternalTarget('cloudflare.com:443')).toBe(false); // With port
        expect(isInternalTarget('93.184.216.34')).toBe(false); // Public IP
    });

    it('should block local domains and hostnames', () => {
        expect(isInternalTarget('localhost')).toBe(true);
        expect(isInternalTarget('localhost:8080')).toBe(true);
        expect(isInternalTarget('my-app.local')).toBe(true);
        expect(isInternalTarget('database.internal')).toBe(true);
    });

    it('should fail-secure on empty or invalid inputs', () => {
        expect(isInternalTarget('')).toBe(true);
        expect(isInternalTarget(null)).toBe(true);
        expect(isInternalTarget(undefined)).toBe(true);
        expect(isInternalTarget(12345)).toBe(true); // Wrong type
        expect(isInternalTarget('http://[:::1]')).toBe(true); // Invalid URL parse
    });

    it('should block standard internal IPv4 addresses', () => {
        expect(isInternalTarget('127.0.0.1')).toBe(true); // Loopback
        expect(isInternalTarget('10.0.0.1')).toBe(true); // Class A
        expect(isInternalTarget('172.16.0.1')).toBe(true); // Class B
        expect(isInternalTarget('192.168.1.100')).toBe(true); // Class C
        expect(isInternalTarget('169.254.169.254')).toBe(true); // AWS Metadata / Link-local
        expect(isInternalTarget('0.0.0.0')).toBe(true); // Zero network
    });

    it('should block standard internal IPv6 addresses', () => {
        expect(isInternalTarget('::1')).toBe(true); // Loopback
        expect(isInternalTarget('[::1]')).toBe(true); // Bracketed Loopback
        expect(isInternalTarget('[::1]:80')).toBe(true); // Bracketed with port
        expect(isInternalTarget('fd00::1')).toBe(true); // ULA
        expect(isInternalTarget('fc00::')).toBe(true); // ULA
        expect(isInternalTarget('fe80::1')).toBe(true); // Link-local
        expect(isInternalTarget('::ffff:127.0.0.1')).toBe(true); // IPv4-mapped
    });

    it('should block OBFUSCATED IPv4 payloads', () => {
        expect(isInternalTarget('0177.0.0.1')).toBe(true); // Octal
        expect(isInternalTarget('0x7f.0.0.1')).toBe(true); // Hex
        expect(isInternalTarget('0x7f000001')).toBe(true); // Hex combined
        expect(isInternalTarget('2130706433')).toBe(true); // Decimal / Integer
        expect(isInternalTarget('127.1')).toBe(true); // Shorthand
    });
});