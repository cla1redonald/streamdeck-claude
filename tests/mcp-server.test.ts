import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BrokerState } from "../src/broker-state.js";
import { createBrokerServer } from "../src/broker-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(REPO, "dist/index.js");

let broker: Server | null = null;
let client: Client | null = null;

// Always rebuild so the test never runs against a stale dist/.
beforeAll(() => {
  execSync("npm run build", { stdio: "ignore", cwd: REPO });
}, 60_000);

afterEach(async () => {
  if (client) await client.close().catch(() => {});
  client = null;
  if (broker) await new Promise<void>((r) => broker!.close(() => r()));
  broker = null;
});

async function startBroker(secret?: string): Promise<{ state: BrokerState; baseUrl: string }> {
  const state = new BrokerState();
  broker = createBrokerServer(state, { port: 0, secret });
  await new Promise<void>((r) => broker!.once("listening", r));
  const port = (broker.address() as AddressInfo).port;
  return { state, baseUrl: `http://127.0.0.1:${port}` };
}

async function connectMcp(brokerUrl: string, secret?: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "STREAMDECK_BROKER_SECRET") env[key] = value;
  }
  env.BROKER_URL = brokerUrl;
  if (secret !== undefined) env.STREAMDECK_BROKER_SECRET = secret;
  const transport = new StdioClientTransport({ command: "node", args: [SERVER_PATH], env });
  const c = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await c.connect(transport);
  return c;
}

describe("MCP server as broker client (e2e)", () => {
  it("lists request_approval", async () => {
    const { baseUrl } = await startBroker();
    client = await connectMcp(baseUrl);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("request_approval");
  });

  it("advertises a JSON Schema generated from the zod input", async () => {
    const { baseUrl } = await startBroker();
    client = await connectMcp(baseUrl);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "request_approval");
    const schema = tool?.inputSchema as {
      required?: string[];
      properties: Record<string, { maximum?: number; type?: string }>;
    };
    expect(schema.required).toEqual(["message"]);
    expect(schema.properties.timeoutMs.type).toBe("integer");
    expect(schema.properties.timeoutMs.maximum).toBe(3_600_000);
  });

  it("rejects invalid input instead of enqueuing it", async () => {
    const { state, baseUrl } = await startBroker();
    client = await connectMcp(baseUrl);
    const result = await client
      .callTool({ name: "request_approval", arguments: { message: "" } })
      .catch((err: Error) => ({ isError: true, content: [{ text: err.message }] }));
    expect(result.isError).toBe(true);
    expect(state.status().queueLength).toBe(0);
  });

  it("request_approval resolves approved after the broker's /approve is hit", async () => {
    const { state, baseUrl } = await startBroker();
    client = await connectMcp(baseUrl);

    const callPromise = client.callTool({
      name: "request_approval",
      arguments: { message: "e2e via broker", timeoutMs: 5000 },
    });

    // wait for the MCP server to enqueue, then approve via the broker's HTTP endpoint
    await pollUntil(() => state.status().pending !== null, 2000);
    const approve = await fetch(`${baseUrl}/approve`, { method: "POST" });
    expect(approve.status).toBe(200);

    const result = await callPromise;
    const parsed = JSON.parse((result.content as { text: string }[])[0].text);
    expect(parsed.outcome).toBe("approved");
  });

  it("sends STREAMDECK_BROKER_SECRET so a secured broker accepts the request", async () => {
    const { state, baseUrl } = await startBroker("shared-secret");
    client = await connectMcp(baseUrl, "shared-secret");

    const callPromise = client.callTool({
      name: "request_approval",
      arguments: { message: "secured", timeoutMs: 5000 },
    });
    await pollUntil(() => state.status().pending !== null, 2000);
    const approve = await fetch(`${baseUrl}/approve`, {
      method: "POST",
      headers: { "x-broker-secret": "shared-secret" },
    });
    expect(approve.status).toBe(200);

    const result = await callPromise;
    expect(JSON.parse((result.content as { text: string }[])[0].text).outcome).toBe("approved");
  });

  it("explains a missing secret instead of hanging", async () => {
    const { baseUrl } = await startBroker("shared-secret");
    client = await connectMcp(baseUrl);
    const result = await client.callTool({
      name: "request_approval",
      arguments: { message: "no secret", timeoutMs: 5000 },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/HTTP 401.*STREAMDECK_BROKER_SECRET/);
  });

  it("returns a clear error (not a hang) when the broker is unreachable", async () => {
    // point at a port with nothing listening
    client = await connectMcp("http://127.0.0.1:59999");
    const result = await client.callTool({
      name: "request_approval",
      arguments: { message: "no broker", timeoutMs: 5000 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toMatch(/broker is not running/i);
  });
});

async function pollUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("pollUntil timed out");
}
