#!/usr/bin/env node
/**
 * Perplexity Direct Gateway Server
 * 
 * OpenAI-compatible HTTP API backed by Perplexity's web API.
 * No browser needed — direct HTTP calls with cookie auth.
 * 
 * Features:
 *   ◆ Serial request queue (protects your Pro account)
 *   ◆ Cookie lifecycle management with auto-refresh
 *   ◆ Human-like timing simulation
 *   ◆ Retry with backoff + model fallback
 * 
 * Usage: node src/server.mjs
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getClient, uploadFile } from './perplexity.mjs';
import { PRODUCT } from './product.mjs';

const PORT = parseInt(process.env.PORT || '8788', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PROXY_KEY = process.env.PERPLEXITY_PROXY_KEY || '';
const SESSION_FILE = process.env.PERPLEXITY_SESSION_FILE || join(homedir(), '.perplexity-session.txt');

const MODEL_CATALOG = [
  'best',
  'sonar',
  'gemini',
  'gemini-thinking',
  'sonnet',
  'sonnet-thinking',
  'kimi',
  'glm',
  'grok',
  'grok-thinking',
  'nemotron',
];

// ─── Helpers ───────────────────────────────────────────────

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function buildError(message, type = 'api_error', code = undefined) {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  const systemText = messages
    .filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : m.content?.map(c => c.text || '').join(''))
    .filter(Boolean).join('\n\n');
  const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (turns.length === 0) throw new Error('at least one user message required');
  if (turns.length === 1 && !systemText) {
    const c = turns[0].content;
    return (typeof c === 'string' ? c : c?.map(x => x.text || '').join('')).trim();
  }
  const parts = [];
  if (systemText) parts.push(`Instructions: ${systemText}`);
  for (const turn of turns) {
    const label = turn.role === 'assistant' ? 'Assistant' : 'User';
    const text = (typeof turn.content === 'string' ? turn.content : turn.content?.map(c => c.text || '').join('')).trim();
    if (text) parts.push(`${label}: ${text}`);
  }
  return parts.join('\n\n');
}

function estimateTokens(text) {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('invalid JSON')); }
    });
  });
}

function chunk(id, model, delta, finishReason = null) {
  return {
    id, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// ─── Server ───────────────────────────────────────────────

let client = null;

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const path = url.pathname;

    // Auth
    if (PROXY_KEY) {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== PROXY_KEY) return json(res, 401, buildError('invalid API key', 'invalid_request_error'));
    }

    // GET /health
    if (path === '/health' && req.method === 'GET') {
      const cookieAge = client?.cookies?._value
        ? (() => { try { const m = statSync(SESSION_FILE); return Math.floor((Date.now() - m.mtimeMs) / 1000); } catch { return null; } })()
        : null;
      return json(res, 200, {
        status: 'ok',
        provider: 'perplexity-direct',
        product: PRODUCT,
        queueDepth: client?.queueDepth || 0,
        sessionAlive: client?.cookies?.valid || false,
        cookieAgeSeconds: cookieAge,
      });
    }

    // POST /refresh — reload cookie from session file (for launchd/scheduled refresh)
    if (path === '/refresh' && req.method === 'POST') {
      try {
        if (!client) return json(res, 503, buildError('gateway not initialized'));
        await client.cookies.refresh();
        return json(res, 200, { status: 'ok', refreshed: true });
      } catch (e) {
        return json(res, 500, buildError(`refresh failed: ${e.message}`));
      }
    }

    // GET /v1/models
    if (path === '/v1/models' && req.method === 'GET') {
      const created = Math.floor(Date.now() / 1000);
      return json(res, 200, {
        object: 'list',
        data: MODEL_CATALOG.map(id => ({ id, object: 'model', created, owned_by: 'perplexity' })),
      });
    }

    // POST /v1/chat/completions
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      let body;
      try { body = await parseBody(req); }
      catch (e) { return json(res, 400, buildError(e.message, 'invalid_request_error')); }

      let promptText;
      try { promptText = buildPrompt(body.messages); }
      catch (e) { return json(res, 400, buildError(e.message, 'invalid_request_error')); }
      if (!promptText.trim()) return json(res, 400, buildError('prompt is empty'));

      const model = String(body.model || '').replace(/^perplexity[-/]/i, '').toLowerCase();
      const cleanModel = model.replace(/-thinking$/, '');
      const mode = body.mode || (model.startsWith('research:') ? 'research' : 'copilot');

      // Handle attachments
      let attachmentObjs = [];
      if (body.attachments && Array.isArray(body.attachments)) {
        for (const att of body.attachments) {
          if (typeof att === 'string') {
            if (existsSync(att)) {
              try { attachmentObjs.push(await uploadFile(att, client.cookies)); }
              catch (e) { return json(res, 400, buildError(`Upload failed: ${e.message}`)); }
            } else if (att.startsWith('http') || att.startsWith('data:')) {
              attachmentObjs.push({ file_url: att });
            } else {
              return json(res, 400, buildError(`Attachment not found: ${att}`));
            }
          } else if (att && typeof att === 'object') {
            attachmentObjs.push(att);
          }
        }
      }

      try {
        if (body.stream) {
          // ─── Streaming ───
          sse(res);
          const id = `chatcmpl-${randomUUID()}`;
          const modelName = body.model || 'perplexity';
          
          res.write(`data: ${JSON.stringify(chunk(id, modelName, { role: 'assistant' }))}\n\n`);
          
          const stream = await client.enqueueAsk(promptText, {
            model: cleanModel, mode, attachments: attachmentObjs,
          }, promptText.slice(0, 40));
          
          let lastText = '';
          for await (const c of stream) {
            if (c.text && c.text !== lastText) {
              const delta = c.text.slice(lastText.length);
              if (delta) res.write(`data: ${JSON.stringify(chunk(id, modelName, { content: delta }))}\n\n`);
              lastText = c.text;
            }
          }
          
          res.write(`data: ${JSON.stringify(chunk(id, modelName, {}, 'stop'))}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        } else {
          // ─── Non-streaming ───
          const result = await client.enqueueAskComplete(promptText, {
            model: cleanModel,
            mode,
            attachments: attachmentObjs,
            allowModelFallback: body.strict_model !== true,
          }, promptText.slice(0, 40));
          
          return json(res, 200, {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'perplexity',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: result.text },
              finish_reason: 'stop',
            }],
            usage: {
              prompt_tokens: estimateTokens(promptText),
              completion_tokens: estimateTokens(result.text),
              total_tokens: estimateTokens(promptText) + estimateTokens(result.text),
            },
            citations: result.citations || [],
            perplexity: {
              url: result.threadUrl || '',
              model_applied: cleanModel || 'turbo',
              gateway_product: PRODUCT,
            },
          });
        }
      } catch (e) {
        console.error('Perplexity error:', e.message);
        const status = e.message?.includes('Queue full') ? 429 : 502;
        const empty = e.code === 'EMPTY_COMPLETION';
        return json(res, status, buildError(
          e.message,
          empty ? 'upstream_empty_completion' : 'api_error',
          e.code,
        ));
      }
    }

    return json(res, 404, buildError(`unknown route ${req.method} ${path}`, 'invalid_request_error'));
  } catch (e) {
    console.error('Server error:', e);
    if (!res.headersSent) json(res, 500, buildError('internal server error'));
    res.end();
  }
});

// ─── Startup ───────────────────────────────────────────────

console.log('Starting Perplexity Direct Gateway...');
const startClient = await getClient();
client = startClient;
console.log(`Session ready. Queue depth: ${client.queueDepth}`);

server.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Models: ${MODEL_CATALOG.length} models across 8 providers`);
  console.log(`Queue: serial FIFO, max 50, human-like delays`);
  if (!PROXY_KEY) console.log('PERPLEXITY_PROXY_KEY not set — server is unauthenticated.');
});

// A bounded launchd restart must not cut off an accepted HTTP response.
// KeepAlive stays disabled; this only makes explicit SIGTERM deployments tidy.
process.on('SIGTERM', () => {
  console.log('SIGTERM received; closing Perplexity Direct Gateway.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4_000).unref();
});
