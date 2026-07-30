import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdirSync } from "node:fs";

const dir = "/tmp/claude-1000/-home-lukef-Documents-GitHub-blattbot/0a1fa056-d11b-45c5-9661-066ecca60b7c/scratchpad/smoke-cwd";
mkdirSync(dir, { recursive: true });

const ping = tool("ping", "Returns pong plus the given tag. Call this when asked to ping.", { tag: z.string() }, async ({ tag }) => {
  return { content: [{ type: "text" as const, text: `pong:${tag}` }] };
});

const server = createSdkMcpServer({ name: "smoke", version: "0.0.1", tools: [ping] });

const q = query({
  prompt: "Call the ping tool with tag 'blattbot', then reply with exactly the tool's output.",
  options: {
    cwd: dir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    mcpServers: { smoke: server },
    settingSources: [],
    maxTurns: 3,
  },
});

const seen: string[] = [];
for await (const m of q as AsyncIterable<any>) {
  const label = m.type + (m.subtype ? `/${m.subtype}` : "") + (m.type === "stream_event" ? `:${m.event?.type}` : "");
  seen.push(label);
  if (m.type === "system" && m.subtype === "init") {
    console.log("INIT session_id:", m.session_id, "model:", m.model);
  }
  if (m.type === "assistant") {
    for (const b of m.message?.content ?? []) {
      console.log("ASSISTANT_BLOCK:", b.type, b.type === "text" ? JSON.stringify(b.text).slice(0, 120) : b.name ?? "");
    }
  }
  if (m.type === "user") {
    const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        console.log("TOOL_RESULT:", JSON.stringify(b.content).slice(0, 160));
      }
    }
  }
  if (m.type === "result") {
    console.log("RESULT:", m.subtype ?? "", "is_error:", m.is_error, "cost:", m.total_cost_usd, "text:", JSON.stringify(m.result).slice(0, 160));
  }
}
console.log("MESSAGE_TYPES_SEEN:", [...new Set(seen)].join(", "));
