// OpenAI-compatible chat-completions client with JSON mode.
//
// Works with:
//   - OpenAI         base_url=https://api.openai.com/v1
//   - DeepSeek       base_url=https://api.deepseek.com/v1
//   - OpenRouter     base_url=https://openrouter.ai/api/v1
//   - any OpenAI-compatible provider (LM Studio, Together, etc.)
//
// We force JSON output via response_format: { type: "json_object" } so the
// returned content is parseable. The caller passes a JSON Schema in the user
// prompt; we don't use structured outputs because not every provider supports
// them. We validate the result with a soft schema check (caller passes a
// required-keys array) so a partial LLM answer doesn't take down the studio.

export interface LLMConfig {
  apiKey: string
  baseUrl: string   // e.g. "https://api.openai.com/v1"
  model: string     // e.g. "gpt-4o-mini" or "deepseek-chat"
}

export interface LLMResult {
  raw: string         // the raw model content
  parsed: unknown     // parsed JSON
  duration_ms: number
  prompt_tokens?: number
  completion_tokens?: number
}

export interface LLMOpts {
  system: string
  user: string
  required_keys?: string[]      // soft check: if any of these missing, raise
  temperature?: number          // default 0.4 (low for deterministic structure)
  max_tokens?: number           // default 4096
  timeout_ms?: number           // default 90_000 (1.5 min)
}

export class LLMSchemaError extends Error {
  constructor(message: string, public raw: string) {
    super(message)
  }
}

export async function callLLM(cfg: LLMConfig, opts: LLMOpts): Promise<LLMResult> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeout_ms ?? 90_000)
  const t0 = Date.now()
  let res: Response
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.max_tokens ?? 4096,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(t)
  }
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`llm ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const content = json.choices?.[0]?.message?.content ?? ""
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    throw new LLMSchemaError(`llm returned non-json: ${(e as Error).message}`, content)
  }
  if (opts.required_keys && opts.required_keys.length > 0) {
    const missing = opts.required_keys.filter(k =>
      typeof parsed !== "object" || parsed === null || !(k in (parsed as Record<string, unknown>))
    )
    if (missing.length > 0) {
      throw new LLMSchemaError(`llm output missing required keys: ${missing.join(", ")}`, content)
    }
  }
  return {
    raw: content,
    parsed,
    duration_ms: Date.now() - t0,
    prompt_tokens: json.usage?.prompt_tokens,
    completion_tokens: json.usage?.completion_tokens,
  }
}
