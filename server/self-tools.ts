import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  CURATED_TOOLKITS,
  listConnectedToolkits,
  listToolkitMeta,
  listToolsForToolkit,
} from "./composio.js";
import { availableIntegrations } from "./execution-agent.js";
import { activeProvider as activeEmbeddingProvider } from "./embeddings.js";
import {
  KNOWN_MODELS,
  MODEL_ALIASES,
  getRuntimeModel,
  resolveModelInput,
  setRuntimeModel,
} from "./runtime-config.js";
import {
  describeUserNow,
  getStoredUserTimezone,
  resolveTimezoneInput,
  setUserTimezone,
} from "./timezone-config.js";

export function createSelfMcp() {
  return createSdkMcpServer({
    name: "boop-self",
    version: "0.1.0",
    tools: [
      tool(
        "get_config",
        "Return Boop's runtime configuration: which Claude model it's using, the user's timezone, the current local time, which integrations are loaded, and basic env info. Use when the user asks 'what model are you?', 'what time is it?', 'what timezone am I in?', or anything about the agent itself.",
        {},
        async () => {
          const integrations = availableIntegrations();
          const tzInfo = await describeUserNow();
          const config = {
            model: await getRuntimeModel(),
            envDefault: process.env.BOOP_MODEL ?? "kimi-k2.6",
            availableModels: [...KNOWN_MODELS],
            userTimezone: tzInfo.isExplicit ? tzInfo.timezone : null,
            timezoneFallback: tzInfo.isExplicit ? null : tzInfo.timezone,
            currentLocalTime: tzInfo.now,
            integrationsLoaded: integrations,
            integrationCount: integrations.length,
            composioEnabled: Boolean(process.env.COMPOSIO_API_KEY),
            // Embeddings always available — local Transformers.js fallback
            // kicks in when no paid key is set. Provider tells the user
            // which one is actually running this turn.
            embeddingsEnabled: true,
            embeddingsProvider: activeEmbeddingProvider(),
            discordEnabled: Boolean(process.env.DISCORD_BOT_TOKEN),
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }],
          };
        },
      ),
      tool(
        "set_timezone",
        `Save the user's timezone so Boop can reason about deadlines, "today", "9am tomorrow", and other local-time references correctly. Accepts an IANA timezone ID (e.g. "America/Chicago", "Europe/London") or a friendly alias ("central", "PT", "Dallas", "Tokyo", "UTC", etc.).

Use when the user tells you their timezone or location ("I'm in Dallas", "use central time", "I'm in London"), or proactively after asking when get_config returns a null userTimezone and you need local-time context for the user's request. Don't guess from prior messages — if you're unsure, just ask once.`,
        {
          timezone: z
            .string()
            .describe(
              'Timezone the user just told you. IANA format like "America/New_York" or alias like "eastern" / "Dallas".',
            ),
        },
        async ({ timezone }) => {
          const resolved = resolveTimezoneInput(timezone);
          if (!resolved) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `"${timezone}" isn't a recognized timezone or alias. Pass a canonical IANA ID like "America/Chicago" / "Europe/London" / "Asia/Tokyo", or a friendly name like "central" / "pacific" / "London" / "Tokyo". Ask the user to clarify if needed.`,
                },
              ],
            };
          }
          await setUserTimezone(resolved);
          const tzInfo = await describeUserNow();
          return {
            content: [
              {
                type: "text" as const,
                text: `User timezone set to ${resolved}. Local time there is now ${tzInfo.now}. This will be used for all future date/time reasoning.`,
              },
            ],
          };
        },
      ),
      tool(
        "set_model",
        `Switch the model used for both this dispatcher and any sub-agents. The change applies to the *next* turn (this turn finishes on the current model). Accepts either a canonical ID or a friendly alias.

Aliases: ${Object.keys(MODEL_ALIASES).map((k) => `"${k}"`).join(", ")}
Canonical: ${[...KNOWN_MODELS].map((k) => `"${k}"`).join(", ")}

Use when the user asks to switch models (e.g. "use minimax", "switch to kimi", etc.).`,
        {
          model: z
            .string()
            .describe('Model to use. Canonical ID like "claude-opus-4-7" or alias like "opus".'),
        },
        async ({ model }) => {
          const resolved = resolveModelInput(model);
          if (!resolved) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown model "${model}". Try one of: ${[...KNOWN_MODELS].join(", ")} or aliases ${Object.keys(MODEL_ALIASES).join(", ")}.`,
                },
              ],
            };
          }
          await setRuntimeModel(resolved);
          return {
            content: [
              {
                type: "text" as const,
                text: `Model override set to ${resolved}. Next agent run (interaction or sub-agent) will use it. This current turn keeps the previous model.`,
              },
            ],
          };
        },
      ),
      tool(
        "list_integrations",
        "List the user's currently connected integrations (Gmail, Slack, etc.) with the actual account behind each connection. Use when the user asks 'what tools do I have connected?' or 'which Gmail account?' or 'what integrations are set up?'.",
        {},
        async () => {
          const connected = await listConnectedToolkits();
          const summary = connected.map((c) => ({
            slug: c.slug,
            status: c.status,
            account: c.accountLabel ?? c.accountEmail ?? c.alias ?? "(unknown)",
            connectionId: c.connectionId,
          }));
          return {
            content: [
              {
                type: "text" as const,
                text:
                  summary.length === 0
                    ? "No integrations are currently connected. The user can connect new ones from the Connections panel in the debug UI."
                    : JSON.stringify(summary, null, 2),
              },
            ],
          };
        },
      ),
      tool(
        "search_composio_catalog",
        "Search Composio's full toolkit catalog (1000+ services) by keyword. Returns matching toolkit slugs and descriptions. Use when the user asks 'is there a tool for X?', 'can you connect to Y?', or 'is Z available?' — e.g. 'is there a Notion integration?', 'can you talk to Zendesk?'.",
        {
          query: z
            .string()
            .describe("Keyword to match against toolkit slug, name, or description (case-insensitive)."),
          limit: z.number().int().min(1).max(50).optional().default(15),
        },
        async ({ query, limit }) => {
          const meta = await listToolkitMeta();
          const q = query.trim().toLowerCase();
          const matches: Array<{ slug: string; name: string; description?: string; toolsCount?: number }> = [];
          for (const t of meta.values()) {
            const haystack = `${t.slug} ${t.name} ${t.description ?? ""}`.toLowerCase();
            if (haystack.includes(q)) {
              matches.push({
                slug: t.slug,
                name: t.name,
                description: t.description,
                toolsCount: t.toolsCount,
              });
            }
            if (matches.length >= limit) break;
          }
          return {
            content: [
              {
                type: "text" as const,
                text:
                  matches.length === 0
                    ? `No toolkits in Composio's catalog match "${query}".`
                    : JSON.stringify(matches, null, 2),
              },
            ],
          };
        },
      ),
      tool(
        "inspect_toolkit",
        "Look up a specific Composio toolkit by exact slug. Returns whether it exists, whether it's currently connected, and (if requested) the list of tools it exposes. Use when the user asks 'what can the Slack tool do?' or 'is Notion connected?'.",
        {
          slug: z
            .string()
            .describe("Exact toolkit slug, e.g. 'gmail', 'slack', 'notion', 'linear'. Lowercase."),
          includeTools: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, also fetch the toolkit's tool list (slower)."),
        },
        async ({ slug, includeTools }) => {
          const lower = slug.trim().toLowerCase();
          const meta = await listToolkitMeta();
          const toolkit = meta.get(lower);
          if (!toolkit) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Toolkit "${lower}" is not in Composio's catalog. Try search_composio_catalog with a keyword to find similar ones.`,
                },
              ],
            };
          }
          const connected = (await listConnectedToolkits()).filter((c) => c.slug === lower);
          const curated = CURATED_TOOLKITS.find((t) => t.slug === lower);
          const result: {
            slug: string;
            name: string;
            description?: string;
            toolsCount?: number;
            inCuratedList: boolean;
            authMode?: string;
            connections: Array<{ status: string; account: string; id: string }>;
            availableForSpawn: boolean;
            tools?: Array<{ slug: string; name: string; description?: string }>;
          } = {
            slug: toolkit.slug,
            name: toolkit.name,
            description: toolkit.description,
            toolsCount: toolkit.toolsCount,
            inCuratedList: Boolean(curated),
            authMode: curated?.authMode,
            connections: connected.map((c) => ({
              status: c.status,
              account: c.accountLabel ?? c.accountEmail ?? c.alias ?? "(unknown)",
              id: c.connectionId,
            })),
            availableForSpawn: availableIntegrations().includes(lower),
          };
          if (includeTools) {
            result.tools = await listToolsForToolkit(lower);
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        },
      ),
    ],
  });
}
