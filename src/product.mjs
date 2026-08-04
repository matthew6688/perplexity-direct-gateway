/**
 * Product identity and compatibility contract for Perplexity Direct Gateway.
 * This is the single runtime source used by health and research receipts.
 */
export const PRODUCT = Object.freeze({
  id: 'perplexity-direct-gateway',
  version: '1.1.0',
  apiContract: 'openai-chat-completions.v1',
  researchArtifactContract: 'ai_mode_research.v1',
  sseProtocolProfile: 'text-sources.v1',
  backgroundMode: 'direct-http-no-browser-per-request.v1',
});
