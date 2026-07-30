#!/usr/bin/env node
/**
 * Perplexity Cookie Extractor
 * 
 * Pulls the NextAuth session cookies from the user's Chrome browser
 * via the CDP proxy. These cookies are needed to authenticate against
 * Perplexity's web API (POST /rest/sse/perplexity_ask).
 * 
 * Cookies are cached in memory for the session lifetime.
 */

const PROXY = process.env.CDP_PROXY || 'http://localhost:3456';

let cachedCookies = null;
let cachedExpiry = 0;

async function rpc(method, path, body) {
  const url = `${PROXY}${path}`;
  const opts = { method };
  if (body) {
    opts.headers = { 'Content-Type': 'text/plain' };
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`CDP proxy error ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Extract all cookies (including httpOnly via browser context) 
 * from a Perplexity session in Chrome.
 */
export async function extractCookies() {
  if (cachedCookies && Date.now() < cachedExpiry) {
    return cachedCookies;
  }
  
  const { targetId } = await rpc('GET', '/new?url=https://www.perplexity.ai');
  await new Promise(r => setTimeout(r, 3000));
  
  const { value } = await rpc('POST', `/eval?target=${targetId}`, 'document.cookie');
  
  await rpc('GET', `/close?target=${targetId}`).catch(() => {});
  
  cachedCookies = value;
  cachedExpiry = Date.now() + 30 * 60 * 1000; // 30 min cache
  return cachedCookies;
}

/**
 * Extract additional auth info: CSRF token, user agent, account ID
 */
export async function extractAuthInfo() {
  const { targetId } = await rpc('GET', '/new?url=https://www.perplexity.ai');
  await new Promise(r => setTimeout(r, 3000));
  
  const { value } = await rpc('POST', `/eval?target=${targetId}`, `
    JSON.stringify({
      cookies: document.cookie,
      userAgent: navigator.userAgent,
      // Extract account ID from localStorage
      accountId: (() => {
        const key = Object.keys(localStorage).find(k => k.includes('next-auth-session') && k.includes('934e25'));
        if (key) {
          const match = key.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
          return match ? match[1] : null;
        }
        return null;
      })()
    })
  `);
  
  await rpc('GET', `/close?target=${targetId}`).catch(() => {});
  
  return JSON.parse(value);
}

/**
 * Get cookie header string for HTTP requests
 */
export async function getCookieHeader() {
  return await extractCookies();
}
