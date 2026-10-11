import { randomUUID } from "node:crypto";

export type ApprovalOutcome = "approved" | "denied" | "timeout";

export interface PendingRequest {
  id: string;
  message: string;
  context?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ApprovalResult {
  outcome: ApprovalOutcome;
  decidedAt: number;
}

export interface EnqueueOptions {
  message: string;
  context?: string;
  timeoutMs?: number;
}

interface QueuedRequest extends PendingRequest {
  timer: NodeJS.Timeout;
  waiters: Array<(result: ApprovalResult) => void>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const RESOLVED_TTL_MS = 30 * 1000;

/**
 * FIFO queue of approval requests shared across all Claude sessions.
 * The physical button resolves the head (oldest); each request's waiters
 * are notified when that specific request is decided.
 */
export class BrokerState {
  private queue: QueuedRequest[] = [];
  private recentlyResolved = new Map<string, { result: ApprovalResult; expungeAt: number }>();

  enqueue(options: EnqueueOptions): { id: string } {
    const id = randomUUID();
    const createdAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const expiresAt = createdAt + timeoutMs;

    const timer = setTimeout(() => this.finalize(id, "timeout"), timeoutMs);
    timer.unref?.();

    this.queue.push({
      id,
      message: options.message,
      context: options.context,
      createdAt,
      expiresAt,
      timer,
      waiters: [],
    });
    return { id };
  }

  /**
   * Resolves when the given request id is decided. If it was decided within
   * the retention window (button pressed before this call registered), or the
   * id is unknown, resolves immediately so the caller never hangs.
   */
  waitFor(id: string): Promise<ApprovalResult> {
    const recent = this.recentlyResolved.get(id);
    if (recent) return Promise.resolve(recent.result);

    const req = this.queue.find((r) => r.id === id);
    if (!req) {
      return Promise.resolve({ outcome: "timeout", decidedAt: Date.now() });
    }
    return new Promise((resolve) => req.waiters.push(resolve));
  }

  resolveHead(
    outcome: Exclude<ApprovalOutcome, "timeout">,
  ): { ok: true; id: string } | { ok: false; error: string } {
    const head = this.queue[0];
    if (!head) return { ok: false, error: "no-pending-request" };
    this.finalize(head.id, outcome);
    return { ok: true, id: head.id };
  }

  /** Remove a request without deciding it: used when its requester disconnects. */
  cancel(id: string): void {
    const idx = this.queue.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const [req] = this.queue.splice(idx, 1);
    clearTimeout(req.timer);
    // Wake any waiters so their long-poll responses are written and closed
    // rather than stranded, even though the requester has gone away.
    const result: ApprovalResult = { outcome: "timeout", decidedAt: Date.now() };
    for (const waiter of req.waiters) waiter(result);
  }

  status(): { pending: PendingRequest | null; queueLength: number } {
    const head = this.queue[0];
    return {
      pending: head ? this.toPublic(head) : null,
      queueLength: this.queue.length,
    };
  }

  private finalize(id: string, outcome: ApprovalOutcome): void {
    const idx = this.queue.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const [req] = this.queue.splice(idx, 1);
    clearTimeout(req.timer);

    const result: ApprovalResult = { outcome, decidedAt: Date.now() };
    this.recentlyResolved.set(id, { result, expungeAt: Date.now() + RESOLVED_TTL_MS });
    this.pruneResolved();

    for (const waiter of req.waiters) waiter(result);
  }

  private pruneResolved(): void {
    const now = Date.now();
    for (const [id, entry] of this.recentlyResolved) {
      if (entry.expungeAt <= now) this.recentlyResolved.delete(id);
    }
  }

  private toPublic(r: QueuedRequest): PendingRequest {
    const { id, message, context, createdAt, expiresAt } = r;
    return { id, message, context, createdAt, expiresAt };
  }
}
