/**
 * The localhost opencode helper (ob 1900): the LAN self-host's way to give the AI explain step a
 * model through the `opencode` CLI. workerd cannot spawn a process, so apps/web calls this helper as
 * it would any OpenAI-compatible endpoint (`POST <baseUrl>/chat/completions`, the shape of
 * `complete()` in `src/ai/model.ts`), and the helper answers through the engine's tool-less
 * `askOpencode` runner. Opt-in: `update.sh` installs it only when the switch is on. See
 * apps/web/README.md, "The AI explain step through opencode".
 *
 * Bound to 127.0.0.1, nothing else is served, and the request's images go to a private temp dir that
 * is removed when the call ends. The provider key is read from a 0600 token file and handed to
 * opencode in its environment: it is never in git, the unit file, a log line or a reply. No
 * dependency beyond the engine's judge runner, which is in the checkout.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askOpencode, bunSpawn, JudgeError, type SpawnProc } from "@pixelslash/engine/judge";

export const CHAT_PATH = "/v1/chat/completions";
/** update.sh points the orgs at this port. */
const PORT = 4180;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES = 9;
/** `provider/model` as opencode writes it. No leading dash: it would be read as a flag. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IMAGE_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export type HelperDeps = {
  spawn?: SpawnProc;
  /** The run of one call is killed after this; the client gives up at 20 s, so a little less. */
  runTimeoutMs?: number;
  /** Calls running at once: each is an opencode process, and the CT has no memory to spare. */
  maxConcurrent?: number;
  log?: (line: string) => void;
};

type Image = { ext: string; bytes: Buffer };
type Chat = { model: string; prompt: string; images: Image[] };

class BadRequest extends Error {}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const failure = (status: number, message: string) => json(status, { error: { message } });

/** `key` of `value` when it is an object, else null. */
const prop = (value: unknown, key: string): unknown =>
  typeof value === "object" && value ? Reflect.get(value, key) : null;

/** The decoded image of a `data:image/...;base64,` URL, and nothing else. */
function imageOf(part: unknown): Image {
  const url = prop(prop(part, "image_url"), "url");
  const match = typeof url === "string" ? IMAGE_URL.exec(url) : null;
  if (!match?.[1] || !match[2]) throw new BadRequest("an image must be a base64 data URL");
  return { ext: match[1] === "jpeg" ? "jpg" : match[1], bytes: Buffer.from(match[2], "base64") };
}

/** The message content as parts: a plain string is one text part. */
function partsOf(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

/** The prompt text and the images of the message parts. */
function collect(parts: unknown[]): { text: string; images: Image[] } {
  const text: string[] = [];
  const images: Image[] = [];
  for (const part of parts) {
    const type = prop(part, "type");
    const words = prop(part, "text");
    if (type === "image_url") images.push(imageOf(part));
    else if (type === "text" && typeof words === "string") text.push(words);
    else throw new BadRequest("a message part must be text or image_url");
  }
  return { text: text.join("\n").trim(), images };
}

/** The model, the prompt text and the images of a chat-completions body with one user message. */
function parseChat(body: unknown): Chat {
  const model = prop(body, "model");
  if (typeof model !== "string" || !MODEL.test(model))
    throw new BadRequest("model must be provider/model");
  const messages = prop(body, "messages");
  const { text, images } = collect(
    partsOf(prop(Array.isArray(messages) ? messages[0] : null, "content")),
  );
  // The build's summary is a text-only call; a region's explanation carries its three crops.
  if (images.length > MAX_IMAGES) throw new BadRequest(`send at most ${MAX_IMAGES} images`);
  if (!text) throw new BadRequest("the message has no text");
  // A prompt that opens with a dash would be read by opencode as one of its own flags.
  return { model, prompt: text.startsWith("-") ? `Task: ${text}` : text, images };
}

/** At most `limit` holders at a time; a waiter that is aborted leaves the line. */
function semaphore(limit: number) {
  let free = limit;
  const waiting: (() => void)[] = [];
  return {
    async acquire(signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new Error("the client went away before its turn");
      if (free > 0) {
        free--;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const turn = () => {
          signal.removeEventListener("abort", leave);
          resolve();
        };
        const leave = () => {
          waiting.splice(waiting.indexOf(turn), 1);
          reject(new Error("the client went away while waiting"));
        };
        waiting.push(turn);
        signal.addEventListener("abort", leave, { once: true });
      });
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else free++;
    },
  };
}

/** The chat of a request, or the reply that refuses it. */
async function readChat(req: Request): Promise<Chat | Response> {
  const path = new URL(req.url).pathname;
  if (path !== CHAT_PATH) return failure(404, "only POST /v1/chat/completions is served");
  if (req.method !== "POST") return failure(405, "only POST /v1/chat/completions is served");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
    return failure(413, "the request is too large");
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return failure(413, "the request is too large");
    return parseChat(JSON.parse(text));
  } catch (e) {
    return failure(400, e instanceof BadRequest ? e.message : "the body is not JSON");
  }
}

/** One chat-completions reply carrying the model's answer. */
const completion = (model: string, answer: string) =>
  json(200, {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
  });

/** One journal line to stdout: systemd's journal takes it from there. */
const toJournal = (line: string) => process.stdout.write(`${line}\n`);

/** The request handler: `fetch` of a server, or of a test. */
export function createHandler(deps: HelperDeps = {}): (req: Request) => Promise<Response> {
  const spawn = deps.spawn ?? bunSpawn;
  const runTimeoutMs = deps.runTimeoutMs ?? 18_000;
  const log = deps.log ?? toJournal;
  const slots = semaphore(deps.maxConcurrent ?? 1);

  /** Writes the images to `dir`, asks opencode and answers; the temp dir is the caller's to remove. */
  async function ask(chat: Chat, dir: string, signal: AbortSignal): Promise<string> {
    const files = await Promise.all(
      chat.images.map(async (image, i) => {
        const file = join(dir, `image-${i + 1}.${image.ext}`);
        await writeFile(file, image.bytes, { mode: 0o600 });
        return file;
      }),
    );
    // The runner's own 5 minute limit is far beyond what the client waits; a closed connection
    // kills the run as well.
    const bounded: SpawnProc = (cmd, opts) =>
      spawn(cmd, { ...opts, timeout: runTimeoutMs, signal });
    return askOpencode(chat.prompt, files, { model: chat.model, spawn: bounded, cwd: dir });
  }

  return async (req) => {
    const chat = await readChat(req);
    if (chat instanceof Response) return chat;

    const started = Date.now();
    const said = (outcome: string) =>
      log(`${chat.model} images=${chat.images.length} ${Date.now() - started}ms ${outcome}`);
    try {
      await slots.acquire(req.signal);
    } catch {
      said("dropped: the client went away while queued");
      return failure(499, "the client went away");
    }
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "ps-opencode-"));
      const answer = await ask(chat, dir, req.signal);
      said(`ok ${answer.length} chars`);
      return completion(chat.model, answer);
    } catch (e) {
      // Only the named reason leaves here: opencode's stderr could echo anything, so it reaches
      // neither the reply nor the journal.
      const reason = e instanceof JudgeError ? e.reason : "error";
      said(`failed: ${reason}`);
      return failure(reason === "timeout" ? 504 : 502, `opencode: ${reason}`);
    } finally {
      slots.release();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
}

if (import.meta.main) {
  const keyFile = process.env.PIXELSLASH_OPENCODE_KEY_FILE;
  if (!keyFile) throw new Error("PIXELSLASH_OPENCODE_KEY_FILE names the token file");
  // update.sh has checked the file's mode and owner. The runner spawns opencode with the process
  // environment, so the key rides there.
  const key = (await readFile(keyFile, "utf8")).trim();
  if (!key) throw new Error(`${keyFile} is empty`);
  process.env.OPENCODE_API_KEY = key;
  const server = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: createHandler() });
  toJournal(`opencode helper on http://${server.hostname}:${server.port}${CHAT_PATH}`);
}
