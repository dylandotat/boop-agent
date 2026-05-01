import { Client, GatewayIntentBits, Events, ChannelType } from "discord.js";
import type { TextChannel, DMChannel } from "discord.js";

// Sendable channels guaranteed to have .send() and .sendTyping().
type SendableChannel = TextChannel | DMChannel;
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";

// Shared client instance — set once in initDiscordBot.
let discordClient: Client | null = null;

const MAX_CHUNK = 2000;

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    const candidate = buf ? buf + "\n" + line : line;
    if (candidate.length > MAX_CHUNK) {
      if (buf) chunks.push(buf);
      buf = line.length > MAX_CHUNK ? line.slice(0, MAX_CHUNK) : line;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export async function sendDiscordMessage(channelId: string, text: string): Promise<void> {
  if (!discordClient) {
    console.warn("[discord] client not initialized — message not sent");
    return;
  }
  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.type === ChannelType.GroupDM) {
      console.error(`[discord] channel ${channelId} is not a sendable text channel`);
      return;
    }
    for (const chunk of chunkText(text)) {
      await (channel as SendableChannel).send(chunk);
    }
  } catch (err) {
    console.error("[discord] send failed", err);
  }
}

// Discord typing indicators expire after ~10 s; refresh every 8 s while working.
export function startTypingLoop(channelId: string): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped || !discordClient) return;
    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (channel?.isTextBased() && channel.type !== ChannelType.GroupDM) {
        await (channel as SendableChannel).sendTyping();
      }
    } catch {
      /* non-fatal */
    }
  };

  tick();
  const timer = setInterval(tick, 8_000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function initDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log("[discord] DISCORD_BOT_TOKEN not set — Discord integration disabled");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bots (including self).
    if (message.author.bot) return;

    // Channel filter: DISCORD_CHANNEL_IDS is a comma-separated list of channel
    // IDs to respond in. When unset, the bot only responds to DMs.
    const allowedChannels = process.env.DISCORD_CHANNEL_IDS
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowedChannels?.length) {
      if (!allowedChannels.includes(message.channelId)) return;
    } else if (message.channel.type !== ChannelType.DM) {
      return;
    }

    // User filter: when DISCORD_USER_ID is set, ignore everyone else.
    const allowedUserId = process.env.DISCORD_USER_ID;
    if (allowedUserId && message.author.id !== allowedUserId) return;

    const content = message.content.trim();
    if (!content) return;

    // Dedup — reuses the sendblueDedup table with a "discord:" prefix.
    const { claimed } = await convex.mutation(api.sendblueDedup.claim, {
      handle: `discord:${message.id}`,
    });
    if (!claimed) return;

    const conversationId = `discord:${message.channelId}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const preview = content.length > 100 ? content.slice(0, 100) + "…" : content;
    console.log(`[turn ${turnTag}] ← ${message.author.username}: ${JSON.stringify(preview)}`);
    const start = Date.now();

    broadcast("message_in", {
      conversationId,
      content,
      from: message.author.username,
      handle: message.id,
    });

    const stopTyping = startTypingLoop(message.channelId);
    try {
      const reply = await handleUserMessage({
        conversationId,
        content,
        turnTag,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        await sendDiscordMessage(message.channelId, reply);
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: reply,
        });
      } else {
        console.log(`[turn ${turnTag}] → (no reply)`);
      }
    } catch (err) {
      console.error(`[turn ${turnTag}] handler error`, err);
    } finally {
      stopTyping();
    }
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] bot ready as ${c.user.tag}`);
  });

  await client.login(token);
  discordClient = client;
}
