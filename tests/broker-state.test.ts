import { describe, it, expect } from "vitest";
import { BrokerState } from "../src/broker-state.js";

describe("BrokerState", () => {
  it("enqueue returns an id and status exposes it as the head", () => {
    const s = new BrokerState();
    const { id } = s.enqueue({ message: "first" });
    expect(typeof id).toBe("string");
    const { pending, queueLength } = s.status();
    expect(pending?.id).toBe(id);
    expect(pending?.message).toBe("first");
    expect(queueLength).toBe(1);
  });

  it("waitFor resolves with approved when resolveHead('approved') is called", async () => {
    const s = new BrokerState();
    const { id } = s.enqueue({ message: "deploy" });
    const waiting = s.waitFor(id);
    const ack = s.resolveHead("approved");
    expect(ack).toEqual({ ok: true, id });
    expect((await waiting).outcome).toBe("approved");
    expect(s.status().pending).toBeNull();
  });

  it("resolveHead acts on the OLDEST request (FIFO)", async () => {
    const s = new BrokerState();
    const a = s.enqueue({ message: "A" });
    const b = s.enqueue({ message: "B" });
    expect(s.status().pending?.id).toBe(a.id);

    const waitA = s.waitFor(a.id);
    const waitB = s.waitFor(b.id);

    s.resolveHead("approved"); // resolves A
    expect((await waitA).outcome).toBe("approved");
    expect(s.status().pending?.id).toBe(b.id); // B is now head

    s.resolveHead("denied"); // resolves B
    expect((await waitB).outcome).toBe("denied");
    expect(s.status().queueLength).toBe(0);
  });

  it("resolves with timeout when no decision is made in time", async () => {
    const s = new BrokerState();
    const { id } = s.enqueue({ message: "x", timeoutMs: 30 });
    expect((await s.waitFor(id)).outcome).toBe("timeout");
    expect(s.status().pending).toBeNull();
  });

  it("resolveHead returns no-pending-request when queue is empty", () => {
    const s = new BrokerState();
    expect(s.resolveHead("approved")).toEqual({ ok: false, error: "no-pending-request" });
  });

  it("cancel removes a request and advances the head", () => {
    const s = new BrokerState();
    const a = s.enqueue({ message: "A" });
    const b = s.enqueue({ message: "B" });
    s.cancel(a.id);
    expect(s.status().pending?.id).toBe(b.id);
    expect(s.status().queueLength).toBe(1);
  });

  it("cancel wakes a registered waiter (so its long-poll response is not stranded)", async () => {
    const s = new BrokerState();
    const { id } = s.enqueue({ message: "abandon me", timeoutMs: 60000 });
    const waiting = s.waitFor(id);
    s.cancel(id);
    // must resolve promptly rather than hang on the now-removed request
    const result = await Promise.race([
      waiting,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("waiter hung")), 200)),
    ]);
    expect(result.outcome).toBe("timeout");
  });

  it("waitFor resolves immediately if the request was decided just before the call (race)", async () => {
    const s = new BrokerState();
    const { id } = s.enqueue({ message: "fast" });
    s.resolveHead("approved"); // button pressed before waitFor registers
    const result = await s.waitFor(id);
    expect(result.outcome).toBe("approved");
  });

  it("waitFor on an unknown id resolves as timeout (never hangs)", async () => {
    const s = new BrokerState();
    expect((await s.waitFor("nope")).outcome).toBe("timeout");
  });

  it("a non-head timeout removes only that request, preserving order", async () => {
    const s = new BrokerState();
    const a = s.enqueue({ message: "A", timeoutMs: 5000 });
    const b = s.enqueue({ message: "B", timeoutMs: 30 });
    expect((await s.waitFor(b.id)).outcome).toBe("timeout");
    expect(s.status().pending?.id).toBe(a.id);
    expect(s.status().queueLength).toBe(1);
  });
});
