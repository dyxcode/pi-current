import type { ContentLibrary } from "../library/types.ts";
import { prepareSources, type PreparationResult } from "../sources/prepare.ts";
import { readSources } from "./sources.ts";

/** One preparation at a time in this Pi runtime; persisted source state survives restarts. */
export class PreparationRuntime {
  private readonly root: string;
  private readonly library: ContentLibrary;
  private readonly onPrepared: (result: PreparationResult) => void;
  private readonly onError: (error: unknown) => void;
  private controller = new AbortController();
  private pending: Promise<PreparationResult> | undefined;
  private active = false;

  constructor(
    root: string,
    library: ContentLibrary,
    onPrepared: (result: PreparationResult) => void,
    onError: (error: unknown) => void = () => {},
  ) {
    this.root = root;
    this.library = library;
    this.onPrepared = onPrepared;
    this.onError = onError;
  }

  start(): void {
    this.active = true;
    this.background();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.controller.abort();
    await this.pending?.catch(() => {});
  }

  async sourcesChanged(): Promise<void> {
    const controller = this.controller;
    controller.abort();
    await this.pending?.catch(() => {});
    if (this.active && this.controller === controller) this.background();
  }

  async ensure(signal?: AbortSignal): Promise<PreparationResult> {
    if (signal?.aborted) throw new Error("CANCELLED");
    if (!this.pending) {
      if (this.controller.signal.aborted) this.controller = new AbortController();
      const controller = this.controller;
      const task = this.prepare(controller).finally(() => {
        if (this.pending === task) this.pending = undefined;
      });
      this.pending = task;
    }
    const pending = this.pending;
    if (!signal) return pending;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("CANCELLED"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  private async prepare(controller: AbortController): Promise<PreparationResult> {
    const sources = await readSources(this.root);
    const result = await prepareSources(this.library, sources, controller.signal);
    if (controller.signal.aborted) throw new Error("CANCELLED");
    if (result.refreshed > 0) this.onPrepared(result);
    return result;
  }

  private background(): void {
    const pending = this.ensure();
    const controller = this.controller;
    void pending.catch((error: unknown) => {
      if (this.active && !controller.signal.aborted) this.onError(error);
    });
  }
}
