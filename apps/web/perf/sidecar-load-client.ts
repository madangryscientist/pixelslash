/** One client of PS-325's harness: the CLI's protocol, over the engine's own `send`. */
import { type Client as Api, isObj, send } from "../../../packages/engine/src/upload-client";
import { form, type Shot } from "./corpus";
import { CONCURRENCY, type Project, SERVER, say } from "./sidecar-load-server";

export type Finalise = {
  ms: number;
  status: string;
  unmeasured: number | null;
  error: string | null;
};

export class Client {
  retries = 0;
  private readonly api: Api;
  private readonly project: Project;
  constructor(project: Project) {
    this.project = project;
    this.api = {
      fetch,
      base: SERVER,
      token: project.token,
      sleep: (ms) => Bun.sleep(ms),
      warn: (message) => {
        this.retries++;
        say(message);
      },
    };
  }

  async open(body: object): Promise<string> {
    const reply = await send(this.api, {
      step: "open build",
      method: "POST",
      path: "/api/v1/builds",
      body: JSON.stringify({ ...body, projectId: this.project.id, clientDiff: true }),
    });
    if (!isObj(reply) || typeof reply["id"] !== "string") throw new Error("open build: no id");
    return reply["id"];
  }

  async putAll(id: string, list: Shot[]): Promise<void> {
    const queue = [...list];
    const worker = async () => {
      for (let shot = queue.shift(); shot; shot = queue.shift())
        await send(this.api, {
          step: `upload ${shot.name}`,
          method: "PUT",
          path: `/api/v1/builds/${id}/snapshots`,
          body: form(shot),
        });
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  /** `finalise` in `packages/engine/src/upload.ts`: again only while the count left falls. */
  async finalise(id: string, count: number): Promise<Finalise[]> {
    const rounds: Finalise[] = [];
    let left = Infinity;
    for (;;) {
      const started = Date.now();
      const reply = await send(this.api, {
        step: "finalize",
        method: "POST",
        path: `/api/v1/builds/${id}/finalize`,
        body: JSON.stringify({ snapshots: count }),
      });
      if (!isObj(reply) || typeof reply["status"] !== "string")
        throw new Error("finalize: no status");
      const now = typeof reply["unmeasured"] === "number" ? reply["unmeasured"] : null;
      const error = typeof reply["error"] === "string" ? reply["error"] : null;
      rounds.push({ ms: Date.now() - started, status: reply["status"], unmeasured: now, error });
      if (reply["status"] !== "errored" || now === null || now <= 0 || now >= left) return rounds;
      left = now;
    }
  }
}
