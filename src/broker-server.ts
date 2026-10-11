import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import type { BrokerState } from "./broker-state.js";

export interface BrokerServerOptions {
  port: number;
  host?: string;
  /**
   * Optional shared secret. When set, /enqueue, /approve and /deny must carry
   * it in the x-broker-secret header. When unset, those routes are open to any
   * local process that passes the Host and Origin checks.
   */
  secret?: string;
}

export const SECRET_HEADER = "x-broker-secret";

/** State-changing routes, which need the secret when one is configured. */
const SECRET_PROTECTED = new Set(["POST /enqueue", "POST /approve", "POST /deny"]);

const EnqueueBody = z.object({
  message: z.string().min(1),
  context: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
});

export function createBrokerServer(state: BrokerState, options: BrokerServerOptions): Server {
  const host = options.host ?? "127.0.0.1";
  const secret = options.secret || undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // Browsers always attach Origin to cross-site POSTs; the MCP server, curl
    // and the Stream Deck scripts never do. Reject before anything else.
    if (req.headers.origin !== undefined) {
      return json(res, 403, { error: "origin-not-allowed" });
    }

    // Defeats DNS rebinding: a rebound hostname arrives with its own Host value.
    if (!isAllowedHost(req.headers.host, server)) {
      return json(res, 403, { error: "host-not-allowed" });
    }

    if (secret && SECRET_PROTECTED.has(`${method} ${url}`) && !secretMatches(req, secret)) {
      return json(res, 401, { error: "invalid-secret" });
    }

    if (method === "GET" && url === "/status") {
      return json(res, 200, state.status());
    }

    if (method === "POST" && url === "/approve") {
      const result = state.resolveHead("approved");
      return json(res, result.ok ? 200 : 409, result);
    }

    if (method === "POST" && url === "/deny") {
      const result = state.resolveHead("denied");
      return json(res, result.ok ? 200 : 409, result);
    }

    if (method === "POST" && url === "/enqueue") {
      return readBody(req, res, (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          return json(res, 400, { error: "invalid-json" });
        }
        const result = EnqueueBody.safeParse(parsed);
        if (!result.success) {
          return json(res, 400, { error: "invalid-body", issues: result.error.issues });
        }
        return json(res, 200, state.enqueue(result.data));
      });
    }

    if (method === "GET" && url.startsWith("/wait/")) {
      const id = decodeURIComponent(url.slice("/wait/".length));
      let settled = false;
      // If the requester goes away before a decision, drop the request so it
      // doesn't block the head for everyone else.
      req.on("close", () => {
        if (!settled) state.cancel(id);
      });
      void state.waitFor(id).then((result) => {
        settled = true;
        json(res, 200, result);
      });
      return;
    }

    return json(res, 404, { error: "not-found", method, url });
  });

  server.on("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    process.stderr.write(
      `streamdeck-broker HTTP server error (${e.code ?? "unknown"}): ${e.message}\n`,
    );
    process.exit(1);
  });

  // Long-poll /wait connections legitimately stay open for the full request
  // timeout (up to 1h), so the usual socket timeouts must be disabled. Safe
  // here because the server is 127.0.0.1-only; a slow client can only be a
  // local process, and BrokerState's per-request timer bounds each wait.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  server.listen(options.port, host);
  return server;
}

function isAllowedHost(hostHeader: string | undefined, server: Server): boolean {
  if (!hostHeader) return false;
  const address = server.address();
  if (address === null || typeof address === "string") return false;
  const value = hostHeader.toLowerCase();
  return value === `127.0.0.1:${address.port}` || value === `localhost:${address.port}`;
}

function secretMatches(req: IncomingMessage, secret: string): boolean {
  const supplied = req.headers[SECRET_HEADER];
  if (typeof supplied !== "string") return false;
  // Hash both sides so the comparison is constant-time whatever the lengths.
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  done: (raw: string) => void,
): void {
  let data = "";
  let aborted = false;
  req.on("data", (chunk) => {
    data += chunk;
    if (data.length > 1_000_000 && !aborted) {
      aborted = true;
      json(res, 413, { error: "body-too-large" });
      req.destroy();
    }
  });
  req.on("end", () => {
    if (!aborted) done(data);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
