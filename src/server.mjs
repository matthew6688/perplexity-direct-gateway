#!/usr/bin/env node
/**
 * Perplexity Direct Gateway Server
 * 
 * OpenAI-compatible HTTP API backed by Perplexity's web API.
 * No browser needed — direct HTTP calls with cookie auth.
 * 
 * Usage: node src/server.mjs
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { askPerplexity, askPerplexityComplete, uploadFile } from './perplexity.mjs';

const PORT = parseInt(process.env.PORT || '8788', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PROXY_KEY = process.env.PERPLEXITY_PROXY_KEY || '';

// Known models — these are the friendly names our gateway accepts
const MODEL_CATALOG = [
  'best',
  'sonar',
  'terra', 'terra-thinking',
  'sol', 'sol-thinking',
  'sonnet', 'sonnet-thinking',
  'opus', 'opus-thinking',
  'haiku',
  'gemini', 'gemini-pro', 'gemini-flash',
  'grok', 'grok-4',
  'glm',
  'kimi', 'kimi-thinking',
  'nemotron',
  // Raw model IDs for direct access
  'gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6',
  'gpt-5-thinking', 'gpt-5.2-thinking', 'gpt-5.4-thinking', 'gpt-5.5-thinking',
];

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

function buildError(message, type = 'api_error') {
  return { error: { message, type } };
}

function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }

  const systemText = messages
    .filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : m.content?.map(c => c.text || '').join(''))
    .filter(Boolean)
    .join('\n\n');

  const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (turns.length === 0) throw new Error('messages must contain at least one user message');

  if (turns.length === 1 && !systemText) {
    const content = turns[0].content;
    return typeof content === 'string' ? content.trim() : content?.map(c => c.text || '').join('').trim();
  }

  const parts = [];
  if (systemText) parts.push(`Instructions: ${systemText}`);
  for (const turn of turns) {
    const label = turn.role === 'assistant' ? 'Assistant' : 'User';
    const text = typeof turn.content === 'string' ? turn.content.trim() : turn.content?.map(c => c.text || '').join('').trim();
    if (text) parts.push(`${label}: ${text}`);
  }
  return parts.join('\n\n');
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('invalid JSON'));
      }
    });
  });
}

function buildStreamChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// ─── Server ───────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const path = url.pathname;

    // Auth check
    if (PROXY_KEY) {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== PROXY_KEY) {
        return json(res, 401, buildError('invalid API key', 'invalid_request_error'));
      }
    }

    // ─── GET /health ───
    if (path === '/health' && req.method === 'GET') {
      return json(res, 200, { status: 'ok', provider: 'perplexity-direct' });
    }

    // ─── GET /v1/models ───
    if (path === '/v1/models' && req.method === 'GET') {
      const created = Math.floor(Date.now() / 1000);
      return json(res, 200, {
        object: 'list',
        data: MODEL_CATALOG.map(id => ({ id, object: 'model', created, owned_by: 'perplexity' })),
      });
    }

    // ─── POST /v1/chat/completions ───
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      let body;
      try {
        body = await parseBody(req);
      } catch (e) {
        return json(res, 400, buildError(e.message, 'invalid_request_error'));
      }

      let promptText;
      try {
        promptText = buildPrompt(body.messages);
      } catch (e) {
        return json(res, 400, buildError(e.message, 'invalid_request_error'));
      }

      if (!promptText.trim()) {
        return json(res, 400, buildError('prompt is empty', 'invalid_request_error'));
      }

      const model = String(body.model || '').replace(/^perplexity[-/]/i, '').toLowerCase();
      const thinking = model.endsWith('-thinking') ? 'on' : '';
      const cleanModel = model.replace(/-thinking$/, '');
      
      const mode = body.mode || (model.startsWith('research:') ? 'research' : 'copilot');
      
      // Handle file attachments: upload local files, pass through URLs
      let attachmentUrls = [];
      if (body.attachments && Array.isArray(body.attachments)) {
        for (const att of body.attachments) {
          if (typeof att === 'string') {
            // Check if it's a local file path
            if (existsSync(att)) {
              console.log(`[server] Uploading attachment: ${att}`);
              try {
                const url = await uploadFile(att);
                attachmentUrls.push(url);
              } catch (e) {
                console.error(`[server] Upload failed for ${att}:`, e.message);
                return json(res, 400, buildError(`Failed to upload ${att}: ${e.message}`, 'invalid_request_error'));
              }
            } else if (att.startsWith('http://') || att.startsWith('https://') || att.startsWith('data:')) {
              // URL or data URI - pass through directly
              attachmentUrls.push(att);
            } else {
              return json(res, 400, buildError(`Attachment not found: ${att}`, 'invalid_request_error'));
            }
          } else if (att && typeof att === 'object' && att.path) {
            // Support { path: '/local/file.pdf' } format too
            if (existsSync(att.path)) {
              try {
                const url = await uploadFile(att.path);
                attachmentUrls.push(url);
              } catch (e) {
                console.error(`[server] Upload failed for ${att.path}:`, e.message);
                return json(res, 400, buildError(`Failed to upload ${att.path}: ${e.message}`, 'invalid_request_error'));
              }
            }
          }
        }
      }
      
      try {
        if (body.stream) {
          // ─── Streaming response ───
          sse(res);
          const id = `chatcmpl-${randomUUID()}`;
          const responseModel = body.model || 'perplexity';
          
          // Send role chunk
          res.write(`data: ${JSON.stringify(buildStreamChunk(id, responseModel, { role: 'assistant' }))}\n\n`);
          
          try {
            const stream = await askPerplexity(promptText, { model: cleanModel, mode, attachments: attachmentUrls });
            let lastText = '';
            
            for await (const chunk of stream) {
              if (chunk.text && chunk.text !== lastText) {
                // Send only the delta (new text since last yield)
                const delta = chunk.text.slice(lastText.length);
                if (delta) {
                  res.write(`data: ${JSON.stringify(buildStreamChunk(id, responseModel, { content: delta }))}\n\n`);
                }
                lastText = chunk.text;
              }
            }
          } catch (e) {
            console.error('Stream error:', e.message);
          }
          
          // Done
          res.write(`data: ${JSON.stringify(buildStreamChunk(id, responseModel, {}, 'stop'))}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
          
        } else {
          // ─── Non-streaming response ───
          const result = await askPerplexityComplete(promptText, { model: cleanModel, mode, attachments: attachmentUrls });
          
          const promptTokens = estimateTokens(promptText);
          const completionTokens = estimateTokens(result.text);
          
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
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
            citations: result.citations || [],
            perplexity: {
              url: result.threadUrl || '',
              model_applied: cleanModel || 'experimental',
            },
          });
        }
      } catch (e) {
        console.error('Perplexity error:', e);
        return json(res, 502, buildError(e.message, 'api_error'));
      }
    }

    // ─── 404 ───
    return json(res, 404, buildError(`unknown route ${req.method} ${path}`, 'invalid_request_error'));

  } catch (e) {
    console.error('Server error:', e);
    if (!res.headersSent) {
      json(res, 500, buildError('internal server error', 'server_error'));
    }
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`perplexity-direct-gateway listening on http://${HOST}:${PORT}`);
  if (!PROXY_KEY) console.log('PERPLEXITY_PROXY_KEY not set — server is unauthenticated, keep it bound to localhost.');
  console.log(`Models: ${MODEL_CATALOG.join(', ')}`);
  console.log('Endpoint: POST /v1/chat/completions');
  console.log('Transport: direct HTTP → perplexity.ai/rest/sse/perplexity_ask (cookie auth)');
});
