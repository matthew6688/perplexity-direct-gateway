#!/usr/bin/env node
/**
 * Perplexity Direct HTTP Client — Aurora Mode
 *
 * Architecture (matches aurora-ops pattern):
 *   1. Cookie read from session.txt (put there once, never committed)
 *   2. If missing, extracted once from Chrome via CDP proxy /cookies
 *   3. Refreshed via pure HTTP: GET /api/auth/session → Set-Cookie
 *   4. Only falls back to CDP when the cookie itself fully expires (~30 days)
 *
 * Zero CDP dependency during normal operation. CDP is only a
 * bootstrap/recovery mechanism.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

const PROXY = process.env.CDP_PROXY || 'http://localhost:3456';
const BASE_URL = 'https://www.perplexity.ai';
const SESSION_FILE = process.env.PERPLEXITY_SESSION_FILE || join(homedir(), '.perplexity-session.txt');
const DISABLE_CDP_FALLBACK = process.env.PERPLEXITY_DISABLE_CDP_FALLBACK === '1';

// ─── Cookie Manager ────────────────────────────────────────

class CookieManager {
  constructor() {
    this._value = null;
    this._expires = 0;
    this._refreshTimer = null;
    this._userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
  }

  /** Extract cookie from Chrome via CDP proxy (bootstrap/recovery only) */
  async _extractFromCDP() {
    const targetsResp = await fetch(`${PROXY}/targets`);
    const targets = await targetsResp.json();
    const pplxTab = targets.find(t => t.url?.includes('perplexity.ai') && !t.url?.includes('service-worker'));
    if (!pplxTab) throw new Error('No Perplexity tab in Chrome — open perplexity.ai first');

    const cookiesResp = await fetch(`${PROXY}/cookies?target=${pplxTab.targetId}&url=${encodeURIComponent(BASE_URL)}`);
    const { cookies } = await cookiesResp.json();
    const sessionCookie = cookies.find(c => c.name === '__Secure-next-auth.session-token');
    if (!sessionCookie) throw new Error('Session cookie not found — log into Perplexity in Chrome');

    return sessionCookie.value;
  }

  /** Refresh cookie via HTTP (same pattern as aurora-ops refresh-token.py) */
  async _refreshViaHTTP() {
    const resp = await fetch(`${BASE_URL}/api/auth/session`, {
      headers: {
        'Cookie': `__Secure-next-auth.session-token=${this._value}`,
        'User-Agent': this._userAgent,
        'Origin': BASE_URL,
      },
    });

    if (!resp.ok) return null;

    // Extract new cookie from Set-Cookie header
    const setCookie = resp.headers.getSetCookie?.() || resp.headers.get('set-cookie')?.split(', ') || [];
    for (const sc of setCookie) {
      const match = sc.match(/^__Secure-next-auth\.session-token=([^;]+)/);
      if (match) return match[1];
    }
    return null;
  }

  async _loadOrBootstrap() {
    // 1. Try session.txt file
    if (existsSync(SESSION_FILE)) {
      this._value = readFileSync(SESSION_FILE, 'utf-8').trim();
      if (this._value) {
        console.log('[cookie] Loaded from session.txt');
        return;
      }
    }

    if (DISABLE_CDP_FALLBACK) {
      throw new Error('Session file missing and CDP fallback is disabled');
    }

    // 2. Bootstrap from Chrome
    console.log('[cookie] No session.txt, extracting from Chrome...');
    this._value = await this._extractFromCDP();
    writeFileSync(SESSION_FILE, this._value, { mode: 0o600 });
    this._expires = Date.now() + 30 * 86400000; // ~30 days (Perplexity session)
    console.log('[cookie] Extracted and saved to session.txt');
  }

  async refresh() {
    // Try HTTP refresh first
    if (this._value) {
      const newCookie = await this._refreshViaHTTP();
      if (newCookie) {
        this._value = newCookie;
        writeFileSync(SESSION_FILE, this._value, { mode: 0o600 });
        this._expires = Date.now() + 30 * 86400000;
        console.log('[cookie] Refreshed via HTTP');
        this.valid = true;
        return true;
      }
    }

    if (DISABLE_CDP_FALLBACK) {
      throw new Error('HTTP session refresh failed and CDP fallback is disabled');
    }

    // HTTP refresh failed — fall back to CDP bootstrap
    console.log('[cookie] HTTP refresh failed, falling back to CDP extraction...');
    this._value = await this._extractFromCDP();
    writeFileSync(SESSION_FILE, this._value, { mode: 0o600 });
    this._expires = Date.now() + 30 * 86400000;
    this.valid = true;
    console.log('[cookie] Refreshed via CDP');
    return true;
  }

  async init() {
    await this._loadOrBootstrap();
    this.valid = true;
    // Refresh every 24 hours via HTTP
    this._refreshTimer = setInterval(() => this.refresh().catch(e => console.warn('[cookie] refresh failed:', e.message)), 24 * 3600000);
  }

  stop() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
  }

  getCookieHeader() {
    if (!this._value) throw new Error('No session cookie');
    return `__Secure-next-auth.session-token=${this._value}`;
  }

  async ensureValid() {
    if (!this._value) await this.refresh();
  }
}

// ─── Human behavior simulation ────────────────────────────

function humanDelay() { return 2000 + Math.random() * 5000; }
function typingTime(queryLength) { return Math.floor(Math.min(queryLength * 15, 3000) + Math.random() * 2000); }

// ─── Serial Request Queue ──────────────────────────────────

class RequestQueue {
  constructor(maxDepth = 50) {
    this._tail = Promise.resolve();
    this._depth = 0;
    this._maxDepth = maxDepth;
  }
  get depth() { return this._depth; }
  async enqueue(task, label = '') {
    if (this._depth >= this._maxDepth) throw new QueueFullError(`Queue full (${this._depth}/${this._maxDepth})`);
    this._depth++;
    const run = this._tail.then(async () => {
      if (this._depth > 1) {
        const delay = humanDelay();
        console.log(`[queue] Waiting ${(delay/1000).toFixed(1)}s before "${label}"... (depth: ${this._depth})`);
        await new Promise(r => setTimeout(r, delay));
      }
      return task();
    }, task);
    this._tail = run.catch(() => {});
    try { return await run; } finally { this._depth--; }
  }
}
class QueueFullError extends Error { constructor(msg) { super(msg); this.name = 'QueueFullError'; } }

// ─── Model mapping ─────────────────────────────────────────

const MODEL_MAP = {
  '': 'turbo', 'default': 'turbo', 'best': 'turbo', 'auto': 'turbo',
  'sonar': 'experimental', 'sonar-2': 'experimental',
  'gemini': 'gemini31pro_low', 'gemini-thinking': 'gemini31pro_high',
  'sonnet': 'claude50sonnet', 'sonnet-thinking': 'claude50sonnetthinking',
  'kimi': 'kimik3thinking', 'glm': 'glm_5_2',
  'grok': 'grok45low', 'grok-thinking': 'grok45medium',
  'nemotron': 'nv_nemotron_3_ultra',
};
const FALLBACK_CHAIN = ['turbo', 'experimental'];

// ─── Perplexity Client ─────────────────────────────────────

export class PerplexityClient {
  constructor() {
    this.cookies = new CookieManager();
    this.queue = new RequestQueue(50);
    this._rumSessionId = randomUUID();
    this._queryCount = 0;
  }

  async start() { await this.cookies.init(); console.log('[client] Ready.'); }
  async stop() { this.cookies.stop(); }
  get queueDepth() { return this.queue.depth; }

  async _askDirect(queryStr, options = {}) {
    this._queryCount++;
    await this.cookies.ensureValid();
    const modelId = MODEL_MAP[options.model] || options.model || 'turbo';
    const cookie = this.cookies.getCookieHeader();

    const body = JSON.stringify({
      params: {
        last_backend_uuid: null, read_write_token: randomUUID(),
        attachments: options.attachments || [],
        language: 'en-US', timezone: 'Australia/Brisbane',
        search_focus: 'internet', sources: ['web'],
        frontend_uuid: randomUUID(), mode: options.mode || 'copilot',
        model_preference: modelId,
        is_related_query: false, is_sponsored: false,
        prompt_source: 'user',
        query_source: this._queryCount % 7 === 0 ? 'followup' : 'new',
        is_incognito: false,
        time_from_first_type: typingTime(queryStr.length),
        local_search_enabled: false,
        use_schematized_api: true,
        // This is the long-running stable request shape. Setting it to true
        // changes Perplexity's SSE block protocol and has produced streams
        // with citations but no parsable answer body under production load.
        // Keep the established markdown-block response shape; the parser
        // still accepts alternate completion fields for forward compatibility.
        send_back_text_in_streaming_api: false,
        // Request only the two blocks this gateway actually persists. Asking
        // for UI/workflow blocks lets upstream select an answer-tabs workflow
        // protocol that contains citations but no durable prose payload.
        supported_block_use_cases: ['markdown_block', 'sources_mode_block'],
        client_coordinates: null, mentions: [],
        skip_search_enabled: true, is_nav_suggestions_disabled: false,
        followup_source: 'link', source: 'default',
        always_search_override: false, override_no_search: false,
        should_ask_for_mcp_tool_confirmation: true,
        supports_tool_approval_modal: true, force_enable_browser_agent: false,
        supported_features: ['browser_agent_permission_banner_v1.1'],
        extended_context: false, is_local_browser_available: false,
        is_local_browser_allowed: false,
        version: '2.18', rum_session_id: this._rumSessionId,
      },
      query_str: queryStr,
    });

    const resp = await fetch(`${BASE_URL}/rest/sse/perplexity_ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'User-Agent': this.cookies._userAgent,
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/search`,
        'Accept': 'text/event-stream',
      },
      body,
    });

    if (resp.status === 403) {
      console.warn('[client] 403 — refreshing cookie and retrying');
      await this.cookies.refresh();
      throw new PerplexityError('SESSION_EXPIRED', 'Session expired — cookie refreshed');
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new PerplexityError(`HTTP_${resp.status}`, text.slice(0, 500));
    }

    return resp.text();
  }

  async *_parseSSE(text) {
    // Perplexity's upstream SSE response is not consistent about its line
    // ending. Some responses use CRLF while others use LF. Splitting only on
    // CRLF turns a valid LF-only stream into one unparsable `data:` line,
    // which then looks like a successful request with an empty answer.
    const lines = text.split(/\r?\n/);
    let fullText = '', threadUrl = '', citations = [], cursor = null;
    let eventCount = 0, blockCount = 0;
    const eventShapes = new Set();
    const blockShapes = new Set();
    const finalValueShapes = new Set();
    let lastCompletionFields = {};
    let lastProtocolFields = {};
    const describe = (value, path = '', depth = 0) => {
      if (depth > 3 || value === null || value === undefined) return;
      if (typeof value === 'string') { if (value.trim()) finalValueShapes.add(`${path}:string:${value.trim().length}`); return; }
      if (Array.isArray(value)) { finalValueShapes.add(`${path}:array:${value.length}`); value.slice(0, 3).forEach((item, index) => describe(item, `${path}[${index}]`, depth + 1)); return; }
      if (typeof value === 'object') Object.entries(value).slice(0, 24).forEach(([key, item]) => describe(item, path ? `${path}.${key}` : key, depth + 1));
    };
    const textFrom = (value) => {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        // Recent upstream responses may wrap every search step and the final
        // answer in one JSON array. Persisting the trace as answer creates a
        // huge, unusable CRM artifact; select only FINAL.answer instead.
        if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
          try { return textFrom(JSON.parse(trimmed)); } catch { /* ordinary text */ }
        }
        return value;
      }
      if (Array.isArray(value)) {
        const final = [...value].reverse().find(item => item && typeof item === 'object' && String(item.step_type || '').toUpperCase() === 'FINAL');
        return final ? textFrom(final.content?.answer || final.answer || final.content) : value.map(textFrom).join('');
      }
      if (value && typeof value === 'object') return textFrom(value.answer || value.text || value.content || value.markdown);
      return '';
    };
    const updateText = (value, status, final = false) => {
      const next = textFrom(value).trim();
      if (!next || next.length <= fullText.length) return null;
      fullText = next;
      return { text: fullText, citations, status, threadUrl, cursor, final };
    };
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let data;
      try { data = JSON.parse(line.slice(6)); } catch { continue; }
      eventCount++;
      for (const key of Object.keys(data)) eventShapes.add(key);
      if (data.cursor) cursor = data.cursor;
      if (data.thread_url_slug) threadUrl = `${BASE_URL}/search/${data.thread_url_slug}`;
      if (data.error_code) throw new PerplexityError(data.error_code, data.text || 'Unknown error');
      if (data.final !== undefined || data.final_sse_message !== undefined || data.text_completed !== undefined) {
        lastCompletionFields = { final: data.final, final_sse_message: data.final_sse_message, text_completed: data.text_completed };
      }
      if (data.answer_modes !== undefined || data.blocks !== undefined) {
        lastProtocolFields = { answer_modes: data.answer_modes, blocks: data.blocks };
      }
      // Perplexity has moved the final prose between several SSE fields over
      // time. `final` and `final_sse_message` are now common on responses
      // that otherwise contain only citation / workflow blocks. Prefer these
      // completion fields before older streaming fields so a successful search
      // is never misclassified as an empty answer.
      const topLevel = updateText(
        data.final_sse_message || data.final || data.text_completed ||
        data.answer || data.text || data.content || data.message,
        data.status,
        data.status === 'COMPLETED',
      );
      if (topLevel) yield topLevel;
      if (data.blocks) {
        for (const block of data.blocks) {
          blockCount++;
          if (block && typeof block === 'object') blockShapes.add(Object.keys(block).sort().join(','));
          const markdown = block.markdown_block || block.answer_block || block.text_block || block;
          const answer = updateText(markdown.answer || markdown.chunks || markdown.text || markdown.content, data.status, data.status === 'COMPLETED');
          if (answer) yield answer;
          if (block.sources_mode_block?.web_results) {
            citations = block.sources_mode_block.web_results.map(r => ({
              title: r.name || '', url: r.url || '', snippet: r.snippet || '',
            }));
            yield { text: fullText, citations, status: data.status, threadUrl, cursor, final: false };
          }
        }
      }
    }
    if (fullText) {
      // Some current upstream text-only responses render source URLs inline
      // while omitting `sources_mode_block`. Preserve those public sources so
      // downstream research receipts never lose their evidence trail.
      if (citations.length === 0) {
        const seen = new Set();
        for (const match of fullText.matchAll(/https?:\/\/[^\s)\]}>,]+/g)) {
          const url = match[0].replace(/[.,;:]+$/, '');
          if (!seen.has(url)) {
            seen.add(url);
            citations.push({ title: '', url, snippet: '' });
          }
        }
      }
      yield { text: fullText, citations, status: 'COMPLETED', threadUrl, cursor, final: true };
    } else {
      // Log protocol shape only, never prompt/cookie/raw upstream contents.
      describe({ ...lastCompletionFields, ...lastProtocolFields });
      console.warn('[client] Empty SSE completion', JSON.stringify({ eventCount, blockCount, eventShapes: [...eventShapes].sort(), blockShapes: [...blockShapes].sort(), finalValueShapes: [...finalValueShapes].sort(), hasThreadUrl: Boolean(threadUrl), citationCount: citations.length }));
    }
  }

  async ask(queryStr, options = {}) {
    let model = options.model || '';
    let lastError = null;
    let fallbackIdx = -1;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sseText = await this._askDirect(queryStr, { ...options, model });
        return this._parseSSE(sseText);
      } catch (e) {
        lastError = e;
        if (e instanceof PerplexityError) {
          if (e.code === 'SESSION_EXPIRED') { continue; }
          if ((e.code === 'INVALID_MODEL_SELECTION' || e.code?.startsWith('HTTP_4'))
              && options.allowModelFallback !== false) {
            fallbackIdx++;
            if (fallbackIdx < FALLBACK_CHAIN.length) {
              model = FALLBACK_CHAIN[fallbackIdx];
              console.warn(`[client] Model failed, falling back to "${model}"`);
              await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
              continue;
            }
          }
        }
        if (attempt < 2) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          console.warn(`[client] Retrying in ${(delay/1000).toFixed(1)}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError || new Error('All retries exhausted');
  }

  async askComplete(queryStr, options = {}) {
    const retries = Math.max(0, Math.min(Number(options.emptyResponseRetries ?? 1), 2));
    for (let attempt = 0; attempt <= retries; attempt++) {
      const stream = await this.ask(queryStr, options);
      let result = { text: '', citations: [], threadUrl: '' };
      for await (const chunk of stream) result = { ...result, ...chunk };
      if (result.text.trim()) return result;
      if (attempt < retries) {
        const delay = 3000 + Math.floor(Math.random() * 2000);
        console.warn(`[client] Empty upstream completion; retrying once in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new PerplexityError('EMPTY_COMPLETION', 'Upstream completion contained no answer text after bounded retry');
  }

  async enqueueAsk(queryStr, options = {}, label = '') {
    return this.queue.enqueue(() => this.ask(queryStr, options), label || queryStr.slice(0, 50));
  }

  async enqueueAskComplete(queryStr, options = {}, label = '') {
    return this.queue.enqueue(() => this.askComplete(queryStr, options), label || queryStr.slice(0, 50));
  }
}

class PerplexityError extends Error {
  constructor(code, message) { super(message); this.name = 'PerplexityError'; this.code = code; }
}

// ─── File Upload ───────────────────────────────────────────

const MIME_MAP = {
  'pdf': 'application/pdf', 'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'txt': 'text/plain', 'text': 'text/plain', 'log': 'text/plain',
  'csv': 'text/csv', 'md': 'text/markdown', 'markdown': 'text/markdown',
  'htm': 'text/html', 'html': 'text/html',
  'xml': 'application/xml', 'json': 'application/json',
  'yaml': 'application/x-yaml', 'yml': 'application/x-yaml', 'toml': 'application/toml',
  'py': 'text/x-python', 'js': 'text/javascript', 'mjs': 'text/javascript',
  'ts': 'text/typescript', 'tsx': 'text/typescript', 'jsx': 'text/javascript',
  'c': 'text/x-c', 'h': 'text/x-c', 'cpp': 'text/x-c++src', 'hpp': 'text/x-c++src',
  'cxx': 'text/x-c++src', 'cs': 'text/x-csharp',
  'java': 'text/x-java', 'go': 'text/x-go', 'rs': 'text/x-rust',
  'swift': 'text/x-swift', 'kt': 'text/x-kotlin', 'scala': 'text/x-scala',
  'dart': 'text/x-dart', 'lua': 'text/x-lua', 'rb': 'text/x-ruby',
  'php': 'text/x-php', 'pl': 'text/x-perl', 'sql': 'text/x-sql',
  'sh': 'text/x-sh', 'bash': 'text/x-sh', 'zsh': 'text/x-sh',
  'css': 'text/css', 'less': 'text/css',
  'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
  'jpe': 'image/jpeg', 'gif': 'image/gif', 'bmp': 'image/bmp',
  'tiff': 'image/tiff', 'tif': 'image/tiff', 'svg': 'image/svg+xml',
  'webp': 'image/webp', 'ico': 'image/x-icon', 'avif': 'image/avif',
  'heic': 'image/heic', 'heif': 'image/heif',
  'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
  'mp4': 'video/mp4', 'mpeg': 'video/mpeg', 'mov': 'video/quicktime',
  'webm': 'video/webm',
};

export async function uploadFile(filePath, cookieManager) {
  const stats = statSync(filePath);
  const fileName = basename(filePath);
  const fileBuffer = readFileSync(filePath);
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  const cookie = cookieManager.getCookieHeader();

  // Step 1: Get upload URL (direct HTTP, no CDP)
  const urlResp = await fetch(`${BASE_URL}/rest/uploads/create_upload_url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
      'User-Agent': cookieManager._userAgent,
      'Origin': BASE_URL,
    },
    body: JSON.stringify({
      filename: fileName, file_size: stats.size,
      mime_type: mime, content_type: mime,
      source: 'default', version: '2.18',
    }),
  });

  if (!urlResp.ok) {
    const detail = await urlResp.text().catch(() => '');
    throw new Error(`Upload URL failed (${urlResp.status}): ${detail.slice(0, 200)}`);
  }

  const uploadData = await urlResp.json();
  const { fields, s3_bucket_url } = uploadData;
  if (!fields || !s3_bucket_url) throw new Error('No S3 fields in upload response');

  // Step 2: Upload to S3 (presigned URL, no auth needed)
  const formData = new FormData();
  for (const [key, val] of Object.entries(fields)) {
    formData.append(key, val);
  }
  formData.append('file', new Blob([fileBuffer], { type: mime }), fileName);

  const s3Resp = await fetch(s3_bucket_url, { method: 'POST', body: formData });
  if (!s3Resp.ok) throw new Error(`S3 upload failed: ${s3Resp.status}`);

  const finalUrl = `${s3_bucket_url}${fields.key}`.replace('${filename}', fileName);
  console.log(`[upload] ${fileName} -> ${finalUrl}`);
  return { file_name: fileName, file_size: stats.size, file_url: finalUrl, content_type: mime };
}

// ─── Singleton ─────────────────────────────────────────────

let _client = null;

export async function getClient() {
  if (!_client) { _client = new PerplexityClient(); await _client.start(); }
  return _client;
}

export async function askPerplexity(queryStr, options = {}) {
  return (await getClient()).ask(queryStr, options);
}

export async function askPerplexityComplete(queryStr, options = {}) {
  return (await getClient()).askComplete(queryStr, options);
}
