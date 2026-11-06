/**
 * At most `limit` of the isolate's calls run at once, first come first served; the rest wait
 * (PS-325). Each caller checks its own turn on a timer rather than being woken by the call before
 * it, because that call may never wake it: workerd can cancel a request whose client went away, and
 * then its `finally` never runs. So nothing here relies on one: a call that stops running gives its
 * place up when its lease ends, and a waiter that stops polling loses its place in the queue.
 */

const POLL_MS = 25;
/** Far above `POLL_MS`, as a busy thread delays every timer. A live waiter dropped by mistake rejoins. */
const WAITER_GONE_MS = 5000;

export type CallGate = <T>(work: () => Promise<T>) => Promise<T>;

export function callGate(
  limit: number,
  leaseMs: number,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): CallGate {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waiting: { seen: number }[] = [];
  let running: { expires: number }[] = [];

  return async (work) => {
    const ticket = { seen: now() };
    waiting.push(ticket);
    for (;;) {
      const at = now();
      ticket.seen = at;
      running = running.filter((call) => call.expires > at);
      while (waiting[0] && at - waiting[0].seen > WAITER_GONE_MS) waiting.shift();
      if (!waiting.includes(ticket)) waiting.push(ticket);
      if (waiting[0] === ticket && running.length < limit) break;
      await sleep(POLL_MS);
    }
    waiting.shift();
    const call = { expires: now() + leaseMs };
    running.push(call);
    try {
      return await work();
    } finally {
      running = running.filter((other) => other !== call);
    }
  };
}
