import assert from 'node:assert/strict';
import { PerplexityClient } from './perplexity.mjs';

async function collect(text) {
  const client = new PerplexityClient();
  let last = null;
  for await (const item of client._parseSSE(text)) last = item;
  return last;
}

const event = JSON.stringify({
  status: 'COMPLETED',
  thread_url_slug: 'test-thread',
  blocks: [{ markdown_block: { answer: 'stable answer' } }],
});

for (const newline of ['\n', '\r\n']) {
  const result = await collect(`data: ${event}${newline}${newline}`);
  assert.equal(result?.text, 'stable answer');
  assert.equal(result?.threadUrl, 'https://www.perplexity.ai/search/test-thread');
}

console.log('perplexity SSE newline compatibility: 2 passed');
