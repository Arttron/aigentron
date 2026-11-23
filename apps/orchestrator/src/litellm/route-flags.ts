/**
 * An `openai/…` route to a base that is not OpenAI itself (LM Studio, llama-server, a gateway, the local agent's /api/local-llm/v1 …): LiteLLM answers the agents'
 * Anthropic-style requests for it through the OpenAI *Responses* API (`/responses`), which such servers do not have — so they are told to use chat completions.
 */
export function needsChatCompletions(backendName: string, apiBase: string | null | undefined): boolean {
  return backendName.startsWith('openai/') && Boolean(apiBase) && !/^https?:\/\/api\.openai\.com(\/|$)/i.test(apiBase!);
}
