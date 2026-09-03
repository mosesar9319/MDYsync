// Direct tests for the link-preview fetcher's SSRF defences.
//
// Run with `npm run test:functions` (node --test). These are deliberately NOT
// Playwright tests: nothing in that suite can reach a Netlify function, and the
// address checks here are the security boundary of the whole feature. A
// boundary exercised only through a live HTTP round trip is not really tested.

import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from '../../netlify/functions/link-preview.mjs';

const { isBlockedAddress, assertAllowedUrl, assertPublicHost, parseMetadata, decodeEntities } = __testing;

test('blocks loopback, private, link-local and reserved IPv4', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3',        // loopback
    '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1', // RFC1918
    '169.254.169.254',               // cloud instance metadata -- the classic target
    '0.0.0.0',
    '100.64.0.1',                    // CGNAT
    '224.0.0.1', '240.0.0.1',        // multicast, reserved
    '198.18.0.1',                    // benchmarking
  ];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
  }
});

test('allows ordinary public IPv4', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isBlockedAddress(address), false, `${address} must be allowed`);
  }
});

test('blocks loopback, link-local and unique-local IPv6', () => {
  for (const address of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1']) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
  }
});

test('an IPv4-mapped IPv6 address cannot smuggle a blocked IPv4 through', () => {
  // Writing 127.0.0.1 as ::ffff:127.0.0.1 must not bypass the v4 blocklist.
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('an unrecognised address is refused rather than guessed at', () => {
  assert.equal(isBlockedAddress('not-an-address'), true);
  assert.equal(isBlockedAddress(''), true);
});

test('only http and https are accepted', () => {
  assert.ok(assertAllowedUrl('https://example.com/a'));
  assert.ok(assertAllowedUrl('http://example.com/a'));
  for (const bad of [
    'file:///etc/passwd',
    'gopher://example.com/',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'ftp://example.com/x',
  ]) {
    assert.throws(() => assertAllowedUrl(bad), /bad-scheme|bad-url/, `${bad} must be refused`);
  }
});

test('credentials in the URL are refused', () => {
  // A preview never needs them, and they are a phishing vector in a rendered link.
  assert.throws(() => assertAllowedUrl('https://user:pass@example.com/'), /bad-url/);
});

test('a malformed URL is refused', () => {
  assert.throws(() => assertAllowedUrl('not a url'), /bad-url/);
});

test('a literal blocked IP as the host is refused before any DNS lookup', async () => {
  await assert.rejects(() => assertPublicHost('169.254.169.254'), /blocked-address/);
  await assert.rejects(() => assertPublicHost('127.0.0.1'), /blocked-address/);
});

test('a hostname that does not resolve is refused', async () => {
  await assert.rejects(
    () => assertPublicHost('this-host-should-not-exist.invalid'),
    /dns-failed|blocked-address/
  );
});

test('metadata parsing prefers OpenGraph and falls back to <title>', () => {
  const html = `<html><head>
    <meta property="og:title" content="Open Graph Title">
    <meta name="description" content="A description.">
    <title>Fallback Title</title>
  </head></html>`;
  const meta = parseMetadata(html, new URL('https://example.com/page'));
  assert.equal(meta.title, 'Open Graph Title');
  assert.equal(meta.description, 'A description.');
  assert.equal(meta.host, 'example.com');
});

test('metadata falls back to <title> when OpenGraph is absent', () => {
  const meta = parseMetadata('<html><head><title>Just A Title</title></head></html>', new URL('https://example.com/'));
  assert.equal(meta.title, 'Just A Title');
});

test('parsed metadata never carries raw markup through', () => {
  const html = `<head><meta property="og:title" content="&lt;script&gt;alert(1)&lt;/script&gt;"></head>`;
  const meta = parseMetadata(html, new URL('https://example.com/'));
  // Entities are decoded for display, but the value is returned as TEXT and the
  // client sets it with textContent -- it is never inserted as markup.
  assert.equal(meta.title, '<script>alert(1)</script>');
  assert.equal(typeof meta.title, 'string');
});

test('entity decoding resolves &amp; last so &amp;lt; does not become a tag', () => {
  assert.equal(decodeEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;');
  assert.equal(decodeEntities('Tom &amp; Jerry'), 'Tom & Jerry');
});

test('a title longer than the cap is truncated', () => {
  const long = 'x'.repeat(500);
  const meta = parseMetadata(`<head><title>${long}</title></head>`, new URL('https://example.com/'));
  assert.equal(meta.title.length, 300);
});
