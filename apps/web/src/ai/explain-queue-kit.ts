import {
  type ConsumerDeps,
  type ExplainJob,
  type ExplainQueue,
  consumeExplain,
} from "./explain-queue";

/** The explain queue in memory, as miniflare runs it: tests only. */

export type MemoryQueue = {
  queue: ExplainQueue;
  /** Jobs sent and not yet delivered. */
  waiting: { body: ExplainJob; attempts: number }[];
  /** Deliver until nothing is left, in batches as the consumer is configured; a retry goes again. */
  drain(deps: ConsumerDeps): Promise<void>;
};

/** `max_batch_size` in wrangler.jsonc. */
const BATCH = 1;

export function memoryQueue(): MemoryQueue {
  const waiting: MemoryQueue["waiting"] = [];
  return {
    waiting,
    queue: {
      async sendBatch(messages) {
        waiting.push(...messages.map(({ body }) => ({ body, attempts: 1 })));
      },
    },
    async drain(deps) {
      while (waiting.length > 0) {
        const batch = waiting.splice(0, BATCH);
        const again: typeof waiting = [];
        await consumeExplain(
          deps,
          batch.map((job) => ({
            body: job.body,
            attempts: job.attempts,
            ack: () => undefined,
            retry: () => {
              again.push({ body: job.body, attempts: job.attempts + 1 });
            },
          })),
        );
        waiting.push(...again);
      }
    },
  };
}
