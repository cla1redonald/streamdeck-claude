import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { BrokerState } from "../src/broker-state.js";
import { createBrokerServer } from "../src/broker-server.js";

let state: BrokerState;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  state = new BrokerState();
  server = createBrokerServer(state, { port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("broker HTTP server", () => {
  it("GET /status is empty initially", async () => {
    const body = await (await fetch(`${baseUrl}/status`)).json();
    expect(body).toEqual({ pending: null, queueLength: 0 });
  });

  it("POST /enqueue returns an id and /status reflects it", async () => {
    const enq = await fetch(`${baseUrl}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "ship it", context: "branch: x" }),
    });
    const { id } = await enq.json();
    expect(typeof id).toBe("string");
    const status = await (await fetch(`${baseUrl}/status`)).json();
    expect(status.pending.message).toBe("ship it");
    expect(status.pending.context).toBe("branch: x");
  });

  it("POST /enqueue rejects a missing message", async () => {
    const res = await fetch(`${baseUrl}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: "no message" }),
    });
    expect(res.status).toBe(400);
  });

  it("end-to-end: enqueue, long-poll /wait, then /approve resolves it", async () => {
    const { id } = await (
      await fetch(`${baseUrl}/enqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "merge PR" }),
      })
    ).json();

    const waitPromise = fetch(`${baseUrl}/wait/${id}`).then((r) => r.json());
    const approve = await fetch(`${baseUrl}/approve`, { method: "POST" });
    expect(approve.status).toBe(200);

    expect((await waitPromise).outcome).toBe("approved");
  });

  it("POST /deny resolves the head as denied", async () => {
    await fetch(`${baseUrl}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "drop table" }),
    });
    const denied = await fetch(`${baseUrl}/deny`, { method: "POST" });
    expect(denied.status).toBe(200);
    expect((await denied.json()).ok).toBe(true);
  });

  it("POST /approve returns 409 when nothing is pending", async () => {
    const res = await fetch(`${baseUrl}/approve`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no-pending-request");
  });

  it("a disconnected /wait cancels its request so the head advances", async () => {
    const a = await (
      await fetch(`${baseUrl}/enqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "A", timeoutMs: 5000 }),
      })
    ).json();
    await fetch(`${baseUrl}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "B", timeoutMs: 5000 }),
    });

    // Start a long-poll on A, then abort it (simulating a dead session).
    const ctrl = new AbortController();
    const waitA = fetch(`${baseUrl}/wait/${a.id}`, { signal: ctrl.signal }).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await waitA;
    await new Promise((r) => setTimeout(r, 50)); // let server process the close

    const status = await (await fetch(`${baseUrl}/status`)).json();
    expect(status.pending.message).toBe("B");
    expect(status.queueLength).toBe(1);
  });

  it("unknown routes return 404", async () => {
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
  });
});

interface RawResponse {
  status: number;
  body: Record<string, unknown>;
}

// node:http lets us set Host and Origin freely, which fetch does not.
function rawRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers }
          : headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || "{}") }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("broker local-authorisation checks", () => {
  it("rejects a request that carries an Origin header", async () => {
    await fetch(`${baseUrl}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "deploy" }),
    });
    const res = await rawRequest(`${baseUrl}/approve`, "POST", { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("origin-not-allowed");
    // The pending request must be untouched.
    expect(state.status().queueLength).toBe(1);
  });

  it("rejects an Origin header on read-only routes too", async () => {
    const res = await rawRequest(`${baseUrl}/status`, "GET", { Origin: "null" });
    expect(res.status).toBe(403);
  });

  it("rejects a Host header that is not loopback with the listening port", async () => {
    const res = await rawRequest(`${baseUrl}/status`, "GET", { Host: "attacker.example:7777" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("host-not-allowed");
  });

  it("rejects the right hostname on the wrong port", async () => {
    const res = await rawRequest(`${baseUrl}/status`, "GET", { Host: "127.0.0.1:1" });
    expect(res.status).toBe(403);
  });

  it("accepts localhost:<port> as the Host", async () => {
    const port = new URL(baseUrl).port;
    const res = await rawRequest(`${baseUrl}/status`, "GET", { Host: `localhost:${port}` });
    expect(res.status).toBe(200);
  });
});

describe("broker shared secret", () => {
  let secured: Server;
  let securedUrl: string;

  async function startSecured(secret: string | undefined): Promise<void> {
    secured = createBrokerServer(new BrokerState(), { port: 0, secret });
    await new Promise<void>((resolve) => secured.once("listening", resolve));
    securedUrl = `http://127.0.0.1:${(secured.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => secured.close(() => resolve()));
  });

  it("rejects /enqueue, /approve and /deny without the secret when one is set", async () => {
    await startSecured("s3cret");
    for (const route of ["/enqueue", "/approve", "/deny"]) {
      const body = route === "/enqueue" ? { message: "x" } : undefined;
      const res = await rawRequest(`${securedUrl}${route}`, "POST", {}, body);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid-secret");
    }
  });

  it("rejects a wrong secret", async () => {
    await startSecured("s3cret");
    const res = await rawRequest(`${securedUrl}/approve`, "POST", { "x-broker-secret": "nope" });
    expect(res.status).toBe(401);
  });

  it("accepts the correct secret", async () => {
    await startSecured("s3cret");
    const headers = { "x-broker-secret": "s3cret" };
    const enqueued = await rawRequest(`${securedUrl}/enqueue`, "POST", headers, { message: "x" });
    expect(enqueued.status).toBe(200);
    const approved = await rawRequest(`${securedUrl}/approve`, "POST", headers);
    expect(approved.status).toBe(200);
  });

  it("leaves /status open so health checks work without the secret", async () => {
    await startSecured("s3cret");
    const res = await rawRequest(`${securedUrl}/status`, "GET", {});
    expect(res.status).toBe(200);
  });

  it("does not require a secret when none is set", async () => {
    await startSecured(undefined);
    const enqueued = await rawRequest(`${securedUrl}/enqueue`, "POST", {}, { message: "x" });
    expect(enqueued.status).toBe(200);
    const approved = await rawRequest(`${securedUrl}/approve`, "POST", {});
    expect(approved.status).toBe(200);
  });

  it("treats an empty secret as unset", async () => {
    await startSecured("");
    const res = await rawRequest(`${securedUrl}/approve`, "POST", {});
    expect(res.status).toBe(409); // reached the handler: nothing pending
  });
});
