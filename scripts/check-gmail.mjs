// Run with: node --env-file=.env.local scripts/check-gmail.mjs
import { Composio } from "@composio/core";
const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const userId = process.env.COMPOSIO_USER_ID || "boop-default";
const all = await composio.connectedAccounts.list({ userIds: [userId] });
const gmail = all.items.filter((it) => it.toolkit?.slug === "gmail");
console.log(`Total Gmail records (any status): ${gmail.length}`);
function decodeJwt(jwt) {
  if (!jwt) return null;
  try {
    const part = jwt.split(".")[1];
    const padded = part + "===".slice((part.length + 3) % 4);
    const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

for (const it of gmail) {
  let scopedEmail = "(unknown)";
  try {
    const r = await composio.tools.execute("GMAIL_GET_PROFILE", {
      userId,
      connectedAccountId: it.id,
      arguments: { user_id: "me" },
      dangerouslySkipVersionCheck: true,
    });
    if (r.successful && r.data) scopedEmail = r.data.emailAddress ?? JSON.stringify(r.data);
  } catch {}
  console.log(JSON.stringify({
    id: it.id,
    alias: it.alias,
    createdAt: it.createdAt,
    email: scopedEmail,
  }));
}

// The c.raroque@gmail.com connection ID
const C_RAROQUE_ID = "ca_3I8rMo3Fn1OL";

const queries = [
  { label: "agent_q1 (4-AND, narrow)", q: 'rent (Cecilia OR Flex OR "Addison Grove") amount due' },
  { label: "drop 'due'", q: 'rent (Cecilia OR Flex OR "Addison Grove") amount' },
  { label: "drop 'amount due'", q: 'rent (Cecilia OR Flex OR "Addison Grove")' },
  { label: "Cecilia + amount + due", q: 'Cecilia amount due' },
  { label: "Conservice in c.raroque", q: 'Conservice' },
];
for (const { label, q } of queries) {
  console.log(`\n--- ${label} :: q="${q}" on c.raroque@gmail.com ---`);
  const r = await composio.tools.execute("GMAIL_FETCH_EMAILS", {
    userId,
    connectedAccountId: C_RAROQUE_ID,
    arguments: { query: q, user_id: "me", max_results: 5, include_payload: false, verbose: false },
    dangerouslySkipVersionCheck: true,
  });
  if (!r.successful) { console.log("  ERROR:", r.error); continue; }
  const messages = r.data?.messages ?? [];
  console.log(`  ${messages.length} hit(s)`);
  for (const m of messages) {
    console.log(`  • ${m.messageTimestamp} | ${m.sender} → ${m.to}`);
    console.log(`    subject: ${m.subject}`);
    if (m.preview?.body) console.log(`    preview: ${m.preview.body.slice(0, 100)}`);
  }
}
