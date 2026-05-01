import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

const MODEL_KEY = "model";
const MODEL_TTL_MS = 30 * 1000;
let cached: { at: number; value: string } | null = null;

// User-friendly aliases for the Opencode Go models.
export const MODEL_ALIASES: Record<string, string> = {
  kimi: "kimi-k2.6",
  "kimi k2": "kimi-k2.6",
  "kimi k2.6": "kimi-k2.6",
  minimax: "minimax-m2.5",
  "minimax 2.5": "minimax-m2.5",
  "minimax m2.5": "minimax-m2.5",
};

export const KNOWN_MODELS = new Set<string>([
  "kimi-k2.6",
  "minimax-m2.5",
]);

export function resolveModelInput(input: string): string | null {
  const lower = input.trim().toLowerCase();
  if (KNOWN_MODELS.has(lower)) return lower;
  return MODEL_ALIASES[lower] ?? null;
}

function envFallback(): string {
  // Agent SDK query() spawns Claude Code CLI which speaks Anthropic /messages
  // format — only minimax-m2.5 (Anthropic-compatible) works there.
  // BOOP_AGENT_MODEL lets ops pin a different compatible model explicitly.
  return process.env.BOOP_AGENT_MODEL ?? process.env.BOOP_MODEL ?? "minimax-m2.5";
}

export async function getRuntimeModel(): Promise<string> {
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.value;
  let stored: string | null = null;
  try {
    stored = await convex.query(api.settings.get, { key: MODEL_KEY });
  } catch (err) {
    console.warn("[runtime-config] settings:get failed", err);
  }
  // Re-validate even though set_model writes through resolveModelInput — the
  // settings table is also writable via the Convex dashboard and other
  // mutations, and a bad value here would surface as an opaque SDK 4xx on the
  // next turn instead of falling back gracefully.
  const final = stored && KNOWN_MODELS.has(stored) ? stored : envFallback();
  cached = { at: Date.now(), value: final };
  return final;
}

export async function setRuntimeModel(model: string): Promise<void> {
  await convex.mutation(api.settings.set, { key: MODEL_KEY, value: model });
  cached = { at: Date.now(), value: model };
}

export async function clearRuntimeModel(): Promise<void> {
  await convex.mutation(api.settings.clear, { key: MODEL_KEY });
  cached = null;
}
