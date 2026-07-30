#!/usr/bin/env node
/**
 * Extract Perplexity session cookie from Chrome via CDP WebSocket.
 * 
 * Usage: node extract-session.mjs [--port <cdp-port>]
 * Outputs: __Secure-next-auth.session-token=<value>
 * 
 * This connects directly to Chrome's CDP (bypasses the CDP proxy)
 * to retrieve httpOnly cookies that are invisible to JS.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

// Auto-discover Chrome debugging port from DevToolsActivePort
function discoverPort() {
  const paths = [
    join(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
    join(homedir(), 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
  ];
  for (const p of paths) {
    try {
      const content = readFileSync(p, 'utf-8').trim();
      const lines = content.split('\n');
      const port = parseInt(lines[0]);
      const wsPath = lines[1] || null;
      if (port > 0 && port < 65536) return { port, wsPath };
    } catch {}
  }
  return { port: 0, wsPath: null };
}

// Fetch JSON from Chrome's HTTP API
async function chromeGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = net.createConnection({ port, host: '127.0.0.1' }, () => {
      req.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      const body = data.split('\r\n\r\n')[1] || '';
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error(`Failed to parse: ${body.slice(0, 200)}`)); }
    });
    req.on('error', reject);
  });
}

// Send CDP command via WebSocket (with optional sessionId)
function cdpCommand(wsUrl, method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    const WS = globalThis.WebSocket;
    const ws = new WS(wsUrl);
    const id = 1;
    let result = null;

    ws.onopen = () => {
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(typeof evt === 'string' ? evt : evt.data);
      if (msg.id === id) {
        ws.close();
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result || msg);
      }
    };

    ws.onerror = (e) => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout')), 10000);
  });
}

// Send multiple CDP commands on same connection
async function cdpSequence(wsUrl, commands) {
  return new Promise((resolve, reject) => {
    const WS = globalThis.WebSocket;
    const ws = new WS(wsUrl);
    const results = [];
    let idx = 0;

    ws.onopen = () => sendNext();

    function sendNext() {
      if (idx >= commands.length) {
        ws.close();
        return resolve(results);
      }
      const { method, params, sessionId } = commands[idx];
      const msg = { id: idx + 1, method, params };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    }

    ws.onmessage = (evt) => {
      const msg = JSON.parse(typeof evt === 'string' ? evt : evt.data);
      if (msg.id) {
        if (msg.error) {
          ws.close();
          reject(new Error(`${msg.error.message} (${commands[msg.id - 1]?.method})`));
        } else {
          results.push(msg.result || msg);
          idx++;
          sendNext();
        }
      }
    };

    ws.onerror = (e) => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout')), 15000);
  });
}

async function main() {
  const { port, wsPath } = discoverPort();
  if (!port) {
    console.error('Could not discover Chrome debugging port.');
    process.exit(1);
  }
  console.error(`Chrome port: ${port}${wsPath ? ' (wsPath: ' + wsPath + ')' : ''}`);

  const wsUrl = wsPath 
    ? `ws://127.0.0.1:${port}${wsPath}`
    : (await chromeGet(port, '/json/version')).webSocketDebuggerUrl;
  console.error(`WS: ${wsUrl.slice(0, 80)}...`);

  // 1. Find a Perplexity page target (not service worker)
  const targetsResp = await cdpCommand(wsUrl, 'Target.getTargets');
  const targets = targetsResp.targetInfos || [];
  const pplxTarget = targets.find(t => 
    t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('service-worker')
  );
  if (!pplxTarget) {
    console.error('No Perplexity tab found in Chrome. Open perplexity.ai first.');
    process.exit(1);
  }
  console.error(`Found tab: ${pplxTarget.url.slice(0, 60)}`);

  // 2. Attach and get cookies — Network commands must go through the page session
  const attachResult = await cdpCommand(wsUrl, 'Target.attachToTarget', { targetId: pplxTarget.targetId, flatten: true });
  const sessionId = attachResult.sessionId;
  if (!sessionId) {
    console.error('Failed to attach to target');
    process.exit(1);
  }

  // Enable Network domain and get cookies on the session
  await cdpCommand(wsUrl, 'Network.enable', {}, sessionId);
  const cookiesResult = await cdpCommand(wsUrl, 'Network.getCookies', { urls: ['https://www.perplexity.ai'] }, sessionId);
  const cookies = cookiesResult.cookies || [];

  for (const c of cookies) {
    if (c.name === '__Secure-next-auth.session-token') {
      console.log(`${c.name}=${c.value}`);
      console.error(`Expires: ${new Date(c.expires * 1000).toISOString()}`);
      process.exit(0);
    }
  }

  console.error(`No __Secure-next-auth.session-token found among ${cookies.length} cookies.`);
  for (const c of cookies) {
    if (c.name.includes('session') || c.name.includes('token') || c.name.includes('auth')) {
      console.error(`  Found: ${c.name}=${c.value.slice(0, 30)}...`);
    }
  }
  process.exit(1);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
