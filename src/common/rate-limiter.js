/**
 * Token-bucket rate limiter guarding every request we make to Vinted.
 *
 * Two constraints stack, because a pure bucket still lets its whole capacity out
 * in the same millisecond, and that burst is exactly what trips edge rate
 * limiting:
 *   1. the bucket keeps the long-run average at refillPerSecond
 *   2. minInterval plus jitter stops any two requests leaving back-to-back
 */
(() => {
  const VB = (globalThis.VB ||= {});

  class RateLimiter {
    /**
     * @param {{capacity?: number, refillPerSecond?: number, minIntervalMs?: number, jitterMs?: number}} [opts]
     */
    constructor(opts) {
      const o = opts || {};
      const d = VB.constants.RATE_LIMIT;
      this.capacity = o.capacity == null ? d.capacity : o.capacity;
      this.refillPerSecond = o.refillPerSecond == null ? d.refillPerSecond : o.refillPerSecond;
      this.minIntervalMs = o.minIntervalMs == null ? d.minIntervalMs : o.minIntervalMs;
      this.jitterMs = o.jitterMs == null ? d.jitterMs : o.jitterMs;

      this.tokens = this.capacity;
      this.lastRefill = Date.now();
      this.lastRelease = 0;
      /** Serialises waiters so they leave in arrival order. */
      this.chain = Promise.resolve();
    }

    refillNow() {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      if (elapsed > 0) {
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
        this.lastRefill = now;
      }
    }

    /** Milliseconds the next request must wait before it may leave. */
    nextDelayMs() {
      this.refillNow();
      const sinceLast = Date.now() - this.lastRelease;
      const spacing = Math.max(0, this.minIntervalMs - sinceLast);
      const starved = this.tokens < 1
        ? Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000)
        : 0;
      const jitter = Math.random() * this.jitterMs;
      return Math.max(spacing, starved) + jitter;
    }

    /**
     * Resolves when the caller is cleared to send. FIFO across concurrent callers.
     * @returns {Promise<void>}
     */
    acquire() {
      const next = this.chain.then(async () => {
        const wait = this.nextDelayMs();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.refillNow();
        this.tokens = Math.max(0, this.tokens - 1);
        this.lastRelease = Date.now();
      });
      // Keep the chain usable even if a waiter continuation rejects later.
      this.chain = next.catch(() => {});
      return next;
    }

    /** Run fn once the limiter clears. */
    async schedule(fn) {
      await this.acquire();
      return fn();
    }
  }

  VB.RateLimiter = RateLimiter;
})();
