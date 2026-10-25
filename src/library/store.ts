import { fork } from "node:child_process";
import type {
  ContentLibrary,
  LibraryBatch,
  LibraryItem,
  ReadRequest,
  SaveRequest,
  SearchRequest,
} from "./types.ts";
import { id, readRequest, saveRequest, searchRequest } from "./validation.mjs";

/** Lazy SQLite adapter. Child processes own connections/transactions; the Pi thread never runs SQL.
 * Process isolation lets cancellation stop native SQLite statements, unlike Worker.terminate().
 * Operations serialize per adapter; SQLite's writer reservation coordinates other instances. */
export class SQLiteContentLibrary implements ContentLibrary {
  private readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private queued = 0;
  constructor(root: string) {
    this.root = root;
  }
  async save(request: SaveRequest, signal?: AbortSignal): Promise<LibraryBatch> {
    saveRequest(request);
    return this.run("save", request, signal);
  }
  async latest(sourceId?: string, signal?: AbortSignal): Promise<LibraryBatch | undefined> {
    return this.run("latest", sourceId, signal);
  }
  async search(request: SearchRequest, signal?: AbortSignal): Promise<LibraryItem[]> {
    searchRequest(request);
    return this.run("search", request, signal);
  }
  async read(request: ReadRequest, signal?: AbortSignal): Promise<LibraryItem | undefined> {
    readRequest(request);
    return this.run("read", request, signal);
  }
  async remove(itemId: string, signal?: AbortSignal): Promise<boolean> {
    id(itemId);
    return this.run("remove", itemId, signal);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail.catch(() => {});
  }
  private async run<T>(operation: string, request: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new Error("LIBRARY_CLOSED");
    if (signal?.aborted) throw new Error("LIBRARY_CANCELLED");
    if (this.queued >= 16) throw new Error("LIBRARY_BUSY");
    this.queued++;
    const snapshot = structuredClone(request);
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.closed) throw new Error("LIBRARY_CLOSED");
        if (signal?.aborted) throw new Error("LIBRARY_CANCELLED");
        const worker = fork(new URL("./worker.mjs", import.meta.url), [], {
          execArgv: ["--max-old-space-size=256"],
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        const exited = new Promise<void>((resolve) => {
          worker.once("exit", () => resolve());
          worker.once("error", () => resolve());
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        try {
          return await new Promise<T>((resolve, reject) => {
            const fail = (reason: string) => reject(new Error(reason));
            const writing = operation === "save" || operation === "remove";
            abort = () => fail(writing ? "LIBRARY_WRITE_UNCERTAIN" : "LIBRARY_CANCELLED");
            signal?.addEventListener("abort", abort, { once: true });
            timer = setTimeout(
              () => fail(writing ? "LIBRARY_WRITE_UNCERTAIN" : "LIBRARY_TIMEOUT"),
              5000,
            );
            worker.once("message", (message: { ok?: boolean; result?: T; code?: string }) => {
              if (message?.ok === true) resolve(message.result as T);
              else
                fail(
                  typeof message?.code === "string" && /^LIBRARY_[A-Z_]+$/.test(message.code)
                    ? message.code
                    : "LIBRARY_STORAGE_ERROR",
                );
            });
            worker.once("error", () =>
              fail(writing ? "LIBRARY_WRITE_UNCERTAIN" : "LIBRARY_STORAGE_ERROR"),
            );
            worker.once("exit", () =>
              fail(writing ? "LIBRARY_WRITE_UNCERTAIN" : "LIBRARY_STORAGE_ERROR"),
            );
            worker.send({ root: this.root, operation, request: snapshot }, (error) => {
              if (error) fail(writing ? "LIBRARY_WRITE_UNCERTAIN" : "LIBRARY_STORAGE_ERROR");
            });
            if (signal?.aborted) abort();
          });
        } finally {
          clearTimeout(timer);
          if (abort) signal?.removeEventListener("abort", abort);
          if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
          await exited;
        }
      });
    this.tail = task;
    try {
      return await task;
    } finally {
      this.queued--;
    }
  }
}
