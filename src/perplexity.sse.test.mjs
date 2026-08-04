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

const directTextEvent = JSON.stringify({
  status: 'COMPLETED',
  thread_url_slug: 'direct-text',
  text: 'text outside markdown block',
});

const arrayContentEvent = JSON.stringify({
  status: 'COMPLETED',
  content: [{ text: 'array content answer' }],
});

const alternateBlockEvent = JSON.stringify({
  status: 'COMPLETED',
  blocks: [{ text_block: { content: 'alternate block answer' } }],
});

const workflowEvent = JSON.stringify({
  status: 'COMPLETED',
  text: JSON.stringify([
    { step_type: 'SEARCH_RESULTS', content: { web_results: [{ url: 'https://noise.example' }] } },
    { step_type: 'FINAL', content: { answer: JSON.stringify({ answer: 'final answer only' }) } },
  ]),
});

const finalMessageEvent = JSON.stringify({
  status: 'COMPLETED',
  final_sse_message: { answer: 'answer carried by final SSE message' },
  blocks: [{ sources_mode_block: { web_results: [{ name: 'source', url: 'https://source.example' }] } }],
});

const textCompletedEvent = JSON.stringify({
  status: 'COMPLETED',
  text_completed: { content: { answer: 'answer carried by text completed' } },
});

for (const newline of ['\n', '\r\n']) {
  const result = await collect(`data: ${event}${newline}${newline}`);
  assert.equal(result?.text, 'stable answer');
  assert.equal(result?.threadUrl, 'https://www.perplexity.ai/search/test-thread');
}

assert.equal((await collect(`data: ${directTextEvent}\n\n`))?.text, 'text outside markdown block');
assert.equal((await collect(`data: ${arrayContentEvent}\n\n`))?.text, 'array content answer');
assert.equal((await collect(`data: ${alternateBlockEvent}\n\n`))?.text, 'alternate block answer');
assert.equal((await collect(`data: ${workflowEvent}\n\n`))?.text, 'final answer only');
assert.equal((await collect(`data: ${finalMessageEvent}\n\n`))?.text, 'answer carried by final SSE message');
assert.equal((await collect(`data: ${textCompletedEvent}\n\n`))?.text, 'answer carried by text completed');

console.log('perplexity SSE parser compatibility: 8 passed');
