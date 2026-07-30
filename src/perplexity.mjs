#!/usr/bin/env node
/**
 * Perplexity Direct HTTP Client
 * 
 * Talks directly to Perplexity's web API (POST /rest/sse/perplexity_ask)
 * using cookie-based auth, bypassing the browser/OpenCLI entirely.
 * 
 * This is the Aurora-equivalent for Perplexity.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { getCookieHeader } from './cookies.mjs';

const BASE_URL = 'https://www.perplexity.ai';
const ASK_ENDPOINT = '/rest/sse/perplexity_ask';
const UPLOAD_URL_ENDPOINT = '/rest/uploads/create_upload_url';
const BATCH_UPLOAD_URL_ENDPOINT = '/rest/uploads/batch_create_upload_urls';

/**
 * Model mapping: our short names → Perplexity's model_preference values.
 * 
 * Perplexity sources models from different providers:
 *   Sonar      → Perplexity in-house
 *   Terra/Sol  → OpenAI (GPT-5.6)  
 *   Sonnet/Opus→ Anthropic (Claude)
 *   Gemini     → Google
 *   Grok       → xAI
 *   GLM        → Zhipu AI (China)
 *   Kimi       → Moonshot AI (China)
 *   Nemotron   → NVIDIA
 *   Best       → Auto-select
 */
/**
 * Model mapping: our short names → Perplexity's actual model_preference IDs.
 * 
 * Real IDs from /rest/models/config/v2:
 *   experimental  → Sonar 2 (Perplexity in-house, default)
 *   turbo         → Best (auto-select)
 *   gpt5, gpt51, gpt52, gpt54, gpt55, gpt54_thinking, etc → OpenAI
 *   claude_sonnet_5, claude_opus_4_8 → Anthropic
 *   gemini_3_1_pro → Google
 *   grok_4_5 → xAI
 *   glm_5_2 → Zhipu AI
 *   kimi_k2_6 → Moonshot AI
 *   nemotron_3_ultra → NVIDIA
 */
const MODEL_MAP = {
  '': 'turbo',
  'default': 'turbo',
  'best': 'turbo',
  'auto': 'turbo',
  'sonar': 'experimental',
  'sonar-2': 'experimental',
  // OpenAI
  'gpt-5': 'gpt5',
  'gpt-5.1': 'gpt51',
  'gpt-5.2': 'gpt52',
  'gpt-5.4': 'gpt54',
  'gpt-5.5': 'gpt55',
  'gpt-5.6': 'gpt56_terra',
  'terra': 'gpt56_terra',
  'terra-thinking': 'gpt56_terra_thinking',
  'sol': 'gpt56_sol',
  'sol-thinking': 'gpt56_sol_thinking',
  'gpt-5-thinking': 'gpt5_thinking',
  'gpt-5.2-thinking': 'gpt52_thinking',
  'gpt-5.4-thinking': 'gpt54_thinking',
  'gpt-5.5-thinking': 'gpt55_thinking',
  // Anthropic  
  'sonnet': 'claude50sonnet',
  'sonnet-thinking': 'claude50sonnetthinking',
  'opus': 'claude50opus',
  'opus-thinking': 'claude50opusthinking',
  'haiku': 'claude45haiku',
  // Google
  'gemini': 'gemini31pro_low',
  'gemini-pro': 'gemini31pro_low',
  'gemini-flash': 'gemini35flash',
  // xAI
  'grok': 'grok45low',
  'grok-4': 'grok4nonthinking',
  // Zhipu
  'glm': 'glm_5_2',
  // Moonshot
  'kimi': 'kimik26instant',
  'kimi-thinking': 'kimik26thinking',
  // NVIDIA
  'nemotron': 'nv_nemotron_3_ultra',
};

/**
 * Build the request body for POST /rest/sse/perplexity_ask
 */
function buildRequestBody(queryStr, { model = '', mode = 'copilot', searchFocus = 'internet', attachments = [] } = {}) {
  const frontendUuid = randomUUID();
  const readWriteToken = randomUUID();
  
  return {
    params: {
      last_backend_uuid: null,        // null = new conversation
      read_write_token: readWriteToken,
      attachments: attachments,        // S3 URLs or data URIs
      language: 'en-US',
      timezone: 'Australia/Brisbane',
      search_focus: searchFocus,
      sources: ['web'],
      frontend_uuid: frontendUuid,
      mode: mode,                      // "copilot" = default, "research" = deep research
      model_preference: MODEL_MAP[model] || model || 'experimental',
      is_related_query: false,
      is_sponsored: false,
      prompt_source: 'user',
      query_source: 'new',             // "new" for new conversation, "followup" for follow-up
      is_incognito: false,
      time_from_first_type: 0,
      local_search_enabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      supported_block_use_cases: [
        'answer_modes', 'markdown_block', 'sources_mode_block',
        'diff_blocks', 'answer_tabs',
      ],
      client_coordinates: null,
      mentions: [],
      skip_search_enabled: true,
      is_nav_suggestions_disabled: false,
      followup_source: 'link',
      source: 'default',
      always_search_override: false,
      override_no_search: false,
      should_ask_for_mcp_tool_confirmation: true,
      supports_tool_approval_modal: true,
      force_enable_browser_agent: false,
      supported_features: ['browser_agent_permission_banner_v1.1'],
      extended_context: false,
      is_local_browser_available: false,
      is_local_browser_allowed: false,
      version: '2.18',
      rum_session_id: randomUUID(),
    },
    query_str: queryStr,
  };
}

/**
 * Parse SSE events from Perplexity's streaming response.
 * Yields { text, citations, status, threadUrl } as the stream progresses.
 */
async function* parseSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';
  
  let fullText = '';
  let threadUrl = '';
  let citations = [];
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\r\n');
    buffer = lines.pop() || ''; // Keep incomplete line
    
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
        continue;
      }
      
      if (!line.startsWith('data: ')) continue;
      
      const dataStr = line.slice(6);
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }
      
      // Check for completion
      if (currentEvent === 'end_of_stream' || data.final_sse_message) {
        done = true;
      }
      
      // Capture thread URL
      if (data.thread_url_slug) {
        threadUrl = `https://www.perplexity.ai/search/${data.thread_url_slug}`;
      }
      
      // Extract text from blocks
      if (data.blocks) {
        for (const block of data.blocks) {
          
          // Full markdown_block answer
          if (block.markdown_block?.answer) {
            fullText = block.markdown_block.answer;
            yield { text: fullText, citations, status: data.status, threadUrl, final: true };
          }
          
          // Markdown from markdown block
          if (block.markdown_block?.markdown) {
            fullText = block.markdown_block.markdown;
            yield { text: fullText, citations, status: data.status, threadUrl, final: true };
          }
          
          // Incremental markdown_block chunks
          if (block.markdown_block?.chunks) {
            const newChunks = block.markdown_block.chunks;
            const newText = newChunks.join('');
            if (newText.length > fullText.length) {
              fullText = newText;
              yield { text: fullText, citations, status: data.status, threadUrl, final: false };
            }
          }
          
          // Sources/citations
          if (block.sources_mode_block?.web_results) {
            citations = block.sources_mode_block.web_results.map(r => ({
              title: r.name || '',
              url: r.url || '',
              snippet: r.snippet || '',
            }));
            yield { text: fullText, citations, status: data.status, threadUrl, final: false };
          }
          
          // JSON Patch diff blocks (incremental updates)
          if (block.diff_block) {
            // These contain incremental patches - we'll rely on markdown_block for final text
          }
        }
      }
    }
  }
  
  // Final yield
  if (fullText) {
    yield { text: fullText, citations, status: 'COMPLETED', threadUrl, final: true };
  }
}

/**
 * Upload a local file to Perplexity (S3) and return the S3 URL.
 * 
 * Flow: 
 *   1. POST /rest/uploads/create_upload_url → get S3 presigned fields + bucket URL
 *   2. POST to S3 with FormData → file lands on S3
 *   3. Returns the final S3 URL for use in attachments[]
 */
export async function uploadFile(filePath) {
  const cookies = await getCookieHeader();
  const stats = statSync(filePath);
  const fileName = basename(filePath);
  const fileBuffer = readFileSync(filePath);
  
  // Detect mime type from extension
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const mimeMap = {
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'csv': 'text/csv',
    'txt': 'text/plain',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'mp3': 'audio/mpeg',
    'mp4': 'video/mp4',
    'wav': 'audio/wav',
    'py': 'text/x-python',
    'js': 'text/javascript',
    'ts': 'text/typescript',
    'json': 'application/json',
    'html': 'text/html',
    'css': 'text/css',
    'md': 'text/markdown',
    'yml': 'text/yaml',
    'yaml': 'text/yaml',
    'xml': 'text/xml',
    'java': 'text/x-java',
    'c': 'text/x-c',
    'cpp': 'text/x-c++',
    'go': 'text/x-go',
    'rs': 'text/x-rust',
    'sh': 'text/x-shellscript',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': cookies,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Origin': 'https://www.perplexity.ai',
    'Referer': 'https://www.perplexity.ai/',
  };
  
  // Step 1: Get upload URL
  const uploadReqBody = {
    file_name: fileName,
    file_size: stats.size,
    mime_type: mime,
    content_type: mime,
    source: 'default',
    version: '2.18',
  };
  
  const uploadUrlResp = await fetch(`${BASE_URL}${UPLOAD_URL_ENDPOINT}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(uploadReqBody),
  });
  
  if (!uploadUrlResp.ok) {
    const errText = await uploadUrlResp.text();
    throw new Error(`Failed to get upload URL: ${uploadUrlResp.status} ${errText.slice(0, 300)}`);
  }
  
  const uploadData = await uploadUrlResp.json();
  console.log('[upload] Got upload URL:', JSON.stringify(uploadData).slice(0, 300));
  
  // Step 2: Upload to S3
  const { fields, s3_bucket_url, file_uuid } = uploadData;
  
  if (!fields || !s3_bucket_url) {
    // Direct URL return (some endpoints return the S3 URL directly)
    if (uploadData.url) return uploadData.url;
    if (uploadData.s3_url) return uploadData.s3_url;
    throw new Error(`Upload response missing fields/s3_bucket_url: ${JSON.stringify(uploadData).slice(0, 300)}`);
  }
  
  const formData = new FormData();
  for (const [key, val] of Object.entries(fields)) {
    formData.append(key, val);
  }
  // The file field is typically named 'file'
  formData.append('file', new Blob([fileBuffer], { type: mime }), fileName);
  
  const s3Resp = await fetch(s3_bucket_url, {
    method: 'POST',
    body: formData,
  });
  
  if (!s3Resp.ok) {
    throw new Error(`S3 upload failed: ${s3Resp.status}`);
  }
  
  // Construct the final S3 URL
  const finalUrl = `${s3_bucket_url}${fields.key}`.replace('${filename}', fileName);
  console.log(`[upload] File uploaded: ${filePath} -> ${finalUrl}`);
  
  return finalUrl;
}

/**
 * Upload multiple files in batch.
 */
export async function uploadFiles(filePaths) {
  return Promise.all(filePaths.map(uploadFile));
}

/**
 * Send a query to Perplexity and get the full answer.
 */
export async function askPerplexity(queryStr, options = {}) {
  const cookies = await getCookieHeader();
  const body = buildRequestBody(queryStr, options);
  
  const response = await fetch(`${BASE_URL}${ASK_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Origin': 'https://www.perplexity.ai',
      'Referer': 'https://www.perplexity.ai/',
    },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${errorText.slice(0, 500)}`);
  }
  
  return parseSSEStream(response);
}

/**
 * Convenience: ask and get the full result (non-streaming).
 */
export async function askPerplexityComplete(queryStr, options = {}) {
  const stream = await askPerplexity(queryStr, options);
  let result = { text: '', citations: [], threadUrl: '' };
  
  for await (const chunk of stream) {
    result = { ...result, ...chunk };
  }
  
  return result;
}
