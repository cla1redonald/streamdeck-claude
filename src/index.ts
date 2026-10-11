#!/usr/bin/env node
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Single source of truth: this zod shape is both the runtime validator and the
// JSON Schema the model sees (McpServer derives one from the other).
const RequestApprovalInput = {
  message: z
    .string()
    .min(1)
    .describe("Human-readable description of what you want approval for."),
  context: z
    .string()
    .optional()
    .describe("Optional extra context (e.g. file paths, command being run)."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 1000)
    .optional()
    .describe(
      "How long to wait for a decision before resolving with outcome=timeout. Default 5 minutes (300000ms). Max 1 hour.",
    ),
};

const TOOL_DESCRIPTION =
  'Pause and request physical approval from the user via their Stream Deck. Returns outcome="approved" if the user presses APPROVE, "denied" if they press DENY, or "timeout" if no decision is made in time. Use before actions that need explicit human consent.';

const brokerUrl = new URL(process.env.BROKER_URL ?? "http://127.0.0.1:7777");
const BROKER = { host: brokerUrl.hostname, port: Number(brokerUrl.port || 7777) };
// Optional. Must match the value the broker was started with.
const SHARED_SECRET = process.env.STREAMDECK_BROKER_SECRET || undefined;

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
}

// node:http (not fetch) so long-poll /wait has no client-side header/body timeout.
function brokerRequest(method: string, path: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (SHARED_SECRET) headers["x-broker-secret"] = SHARED_SECRET;

    const req = http.request(
      { host: BROKER.host, port: BROKER.port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(data || "{}");
          } catch {
            /* leave json empty */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

async function main(): Promise<void> {
  const mcp = new McpServer({ name: "streamdeck-claude", version: "0.2.0" });

  mcp.registerTool(
    "request_approval",
    { description: TOOL_DESCRIPTION, inputSchema: RequestApprovalInput },
    async (input) => {
      try {
        const enqueued = await brokerRequest("POST", "/enqueue", input);
        if (enqueued.status !== 200 || typeof enqueued.json.id !== "string") {
          const detail =
            typeof enqueued.json.error === "string" ? `: ${enqueued.json.error}` : "";
          const hint =
            enqueued.status === 401
              ? " Set STREAMDECK_BROKER_SECRET to the value the broker was started with."
              : "";
          return errorResult(
            `Approval broker rejected the request (HTTP ${enqueued.status}${detail}).${hint}`,
          );
        }
        const decided = await brokerRequest("GET", `/wait/${enqueued.json.id}`);
        const outcome = decided.json.outcome;
        if (outcome !== "approved" && outcome !== "denied" && outcome !== "timeout") {
          return errorResult(
            `Approval broker returned an unrecognised response (HTTP ${decided.status}). The broker may have restarted mid-wait.`,
          );
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(decided.json) }] };
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ECONNREFUSED") {
          return errorResult(
            "Stream Deck approval broker is not running. Start it with ./scripts/install-broker.sh (or run: streamdeck-broker).",
          );
        }
        return errorResult(`Approval request failed: ${e.message}`);
      }
    },
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const shutdown = (): void => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  mcp.server.onclose = shutdown;

  process.stderr.write(
    `streamdeck-claude MCP server ready (broker: http://${BROKER.host}:${BROKER.port})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
