// Server-side link preview fetcher.
//
// The browser must NEVER fetch a preview URL itself: doing so would make every
// reader's machine issue requests to whatever address an author typed, from
// inside their network, with their cookies and their IP. This function does it
// once, server-side, and returns text only.
//
// The threat here is SSRF. A reply body is attacker-controlled, so "fetch this
// URL" is an attacker-chosen request originating inside the deploy environment,
// which can reach things the public internet cannot -- cloud instance metadata
// (169.254.169.254), private ranges, localhost services. The defences below are
// therefore not decoration:
//
//   * scheme allowlist (http/https only -- no file:, gopher:, data:)
//   * DNS resolution BEFORE connecting, with every resolved address checked
//     against blocked ranges, because a hostname an attacker controls can
//     resolve to 127.0.0.1
//   * every redirect hop re-checked the same way, since hop 1 can be public and
//     hop 2 can point at metadata
//   * hard timeout, redirect cap, response size cap, content-type allowlist
//   * only parsed metadata is returned; no remote HTML is ever passed through
//
// It deliberately does not follow non-HTML content, does not return the raw
// body, and does not proxy images -- the client renders text and links to the
// origin.

import dns from 'node:dns/promises';
import net from 'node:net';

const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;
const MAX_BYTES = 512 * 1024;         // enough for a <head>, far short of a payload
const CACHE_SECONDS = 3600;

// Blocked IPv4 ranges, as [network, prefix length].
const BLOCKED_V4 = [
  ['0.0.0.0', 8],          // "this" network
  ['10.0.0.0', 8],         // RFC1918
  ['100.64.0.0', 10],      // CGNAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local -- cloud instance metadata lives here
  ['172.16.0.0', 12],      // RFC1918
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.168.0.0', 16],     // RFC1918
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved
];

function ipv4ToInt(address) {
  return address.split('.').reduce((total, part) => (total << 8) + Number(part), 0) >>> 0;
}

function isBlockedIPv4(address) {
  const value = ipv4ToInt(address);
  return BLOCKED_V4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(network) & mask);
  });
}

function isBlockedIPv6(address) {
  const value = address.toLowerCase();
  if (value === '::' || value === '::1') return true;              // unspecified, loopback
  if (value.startsWith('fe80')) return true;                        // link-local
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique local
  if (value.startsWith('ff')) return true;                          // multicast
  // IPv4-mapped (::ffff:127.0.0.1) must be judged by its IPv4 half, or the
  // whole v4 blocklist is bypassed by writing the address differently.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isBlockedIPv4(mapped[1]);
  return false;
}

function isBlockedAddress(address) {
  if (net.isIPv4(address)) return isBlockedIPv4(address);
  if (net.isIPv6(address)) return isBlockedIPv6(address);
  return true; // unrecognised: refuse rather than guess
}

// Resolves the hostname and refuses if ANY answer is blocked. Checking only the
// first would let a host that returns both a public and a private address slip
// through depending on which one the fetch happens to use.
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error('blocked-address');
    return;
  }
  let answers;
  try {
    answers = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('dns-failed');
  }
  if (!answers.length) throw new Error('dns-failed');
  if (answers.some((answer) => isBlockedAddress(answer.address))) throw new Error('blocked-address');
}

function assertAllowedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('bad-url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad-scheme');
  // Credentials in a preview URL are a phishing vector and never needed.
  if (url.username || url.password) throw new Error('bad-url');
  return url;
}

// Follows redirects manually so each hop can be validated. `redirect: 'follow'`
// would let hop 2 reach an address hop 1 was checked against.
async function fetchWithGuards(startUrl) {
  let url = assertAllowedUrl(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(url.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Identifies the fetcher honestly and asks only for HTML.
          'user-agent': 'DafSync-LinkPreview/1.0 (+https://dafsync.netlify.app)',
          accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch {
      throw new Error('fetch-failed');
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('bad-redirect');
      url = assertAllowedUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error('http-error');

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new Error('not-html');
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) throw new Error('too-large');

    return { response, finalUrl: url };
  }
  throw new Error('too-many-redirects');
}

// Reads at most MAX_BYTES regardless of what the server claims, because
// content-length is the server's word and a preview should not be a way to make
// the function download something enormous.
async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { await reader.cancel(); break; }
    text += decoder.decode(value, { stream: true });
    // The metadata lives in <head>; stop as soon as it closes.
    if (text.includes('</head>')) { await reader.cancel(); break; }
  }
  return text;
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // last, so &amp;lt; does not become <
}

function metaContent(html, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match && match[1] && match[1].trim()) return decodeEntities(match[1].trim()).slice(0, 300);
  }
  return null;
}

function parseMetadata(html, finalUrl) {
  const title = metaContent(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']*)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ]);
  const description = metaContent(html, [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  ]);
  const siteName = metaContent(html, [
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i,
  ]);
  return {
    url: finalUrl.toString(),
    host: finalUrl.hostname,
    title,
    description,
    siteName,
  };
}

export default async (request) => {
  const target = new URL(request.url).searchParams.get('url');
  if (!target) {
    return Response.json({ error: 'missing-url' }, { status: 400 });
  }

  try {
    const { response, finalUrl } = await fetchWithGuards(target);
    const html = await readCapped(response);
    const preview = parseMetadata(html, finalUrl);
    if (!preview.title && !preview.description) {
      return Response.json({ error: 'no-metadata' }, { status: 422 });
    }
    return Response.json(preview, {
      headers: { 'cache-control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS * 6}` },
    });
  } catch (error) {
    // The reason is returned as a short code, never the upstream error text --
    // an upstream message can echo internal hostnames and addresses back to the
    // caller, which is the very thing the address checks exist to protect.
    const reason = error instanceof Error ? error.message : 'failed';
    const status = reason === 'blocked-address' || reason === 'bad-scheme' || reason === 'bad-url' ? 400 : 502;
    return Response.json({ error: reason }, { status });
  }
};

export const config = { path: '/api/link-preview' };

// Exported for tests/functions/link-preview.test.mjs. The address checks are
// the security boundary of this function, and a boundary that is only exercised
// through a live HTTP round trip is a boundary that is not really tested --
// nothing in the Playwright suite can reach a Netlify function at all.
export const __testing = {
  isBlockedAddress,
  isBlockedIPv4,
  isBlockedIPv6,
  assertAllowedUrl,
  assertPublicHost,
  parseMetadata,
  decodeEntities,
  MAX_BYTES,
  MAX_REDIRECTS,
  TIMEOUT_MS,
};
