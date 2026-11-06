/** One client of PS-325's harness: the CLI's protocol (`packages/engine/src/upload.ts`). */
import { form, type Shot } from "./corpus";
import { CONCURRENCY, RETRY_DELAYS_MS, type Project, SERVER, say } from "./sidecar-load-server";

type Attempt = { retries: number };

/** A failure the API never answered, or a 5xx, is tried again, as `upload-client.ts` does. */
async function send(
  call: () => Promise<Response>,
  what: string,
  tally: Attempt,
): Promise<Response> {
  for (let n = 0; ; n++) {
    let failure: string;
    try {
      const res = await call();
      if (res.ok) return res;
      failure = `${res.status} ${(await res.text()).slice(0, 300)}`;
      if (res.status < 500) throw new Error(`${what}: ${failure}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`${what}:`)) throw e;
      failure = e instanceof Error ? e.message : String(e);
    }
    const delay = RETRY_DELAYS_MS[n];
    if (delay === undefined) throw new Error(`${what}: ${failure} (after ${n + 1} tries)`);
    tally.retries++;
    say(`${what}: ${failure}; trying again`);
    await Bun.sleep(delay);
  }
}

export type Finalise = {
  ms: number;
  status: string;
  unmeasured: number | null;
  error: string | null;
};

export class Client {
  readonly tally: Attempt = { retries: 0 };
  private readonly headers: Record<string, string>;
  private readonly project: Project;
  constructor(project: Project) {
    this.project = project;
    this.headers = { authorization: `Bearer ${project.token}` };
  }

  async open(body: object): Promise<string> {
    const res = await send(
      () =>
        fetch(`${SERVER}/api/v1/builds`, {
          method: "POST",
          headers: { ...this.headers, "content-type": "application/json" },
          body: JSON.stringify({ ...body, projectId: this.project.id, clientDiff: true }),
        }),
      "open build",
      this.tally,
    );
    const opened: { id: string } = await res.json();
    return opened.id;
  }

  async putAll(id: string, list: Shot[]): Promise<void> {
    const queue = [...list];
    const worker = async () => {
      for (let shot = queue.shift(); shot; shot = queue.shift()) {
        const current = shot;
        const res = await send(
          () =>
            fetch(`${SERVER}/api/v1/builds/${id}/snapshots`, {
              method: "PUT",
              headers: this.headers,
              body: form(current),
            }),
          `PUT ${current.name}`,
          this.tally,
        );
        await res.arrayBuffer();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  /** `finalise` in `packages/engine/src/upload.ts`: again only while the count left falls. */
  async finalise(id: string, count: number): Promise<Finalise[]> {
    const rounds: Finalise[] = [];
    let left = Infinity;
    for (;;) {
      const started = Date.now();
      const res = await send(
        () =>
          fetch(`${SERVER}/api/v1/builds/${id}/finalize`, {
            method: "POST",
            headers: { ...this.headers, "content-type": "application/json" },
            body: JSON.stringify({ snapshots: count }),
          }),
        "finalize",
        this.tally,
      );
      const reply: { status: string; unmeasured?: number; error?: string | null } =
        await res.json();
      const now = reply.unmeasured ?? null;
      rounds.push({
        ms: Date.now() - started,
        status: reply.status,
        unmeasured: now,
        error: reply.error ?? null,
      });
      if (reply.status !== "errored" || now === null || now <= 0 || now >= left) return rounds;
      left = now;
    }
  }
}
