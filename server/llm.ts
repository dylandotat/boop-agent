// Direct Opencode Go API caller for tool-free LLM operations (extraction,
// consolidation). The main agent orchestration (interaction-agent, execution-agent)
// still uses @anthropic-ai/claude-agent-sdk configured via ANTHROPIC_BASE_URL.
//
// Env vars:
//   OPENCODE_BASE_URL  - base URL, defaults to https://opencode.ai/zen/go/v1
//   OPENCODE_API_KEY   - API key; falls back to ANTHROPIC_API_KEY

function base(): string {
  return (process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1").replace(/\/$/, "");
}

function apiKey(): string {
  return process.env.OPENCODE_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
}

// Kimi K2.6 uses OpenAI chat/completions format.
// Minimax M2.5 and anything else uses Anthropic messages format.
const OPENAI_FORMAT_MODELS = new Set(["kimi-k2.6"]);

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export async function callLlm(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<LlmResult> {
  if (OPENAI_FORMAT_MODELS.has(model)) {
    return callChatCompletions(systemPrompt, userPrompt, model);
  }
  return callMessages(systemPrompt, userPrompt, model);
}

async function callChatCompletions(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<LlmResult> {
  const res = await fetch(`${base()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[llm] chat/completions ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    model,
  };
}

async function callMessages(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<LlmResult> {
  const res = await fetch(`${base()}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[llm] messages ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = json.content?.find((b) => b.type === "text")?.text ?? "";
  return {
    text,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    model,
  };
}
