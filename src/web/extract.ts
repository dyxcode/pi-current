import workerThreads from "node:worker_threads";
import {
  abortFailure,
  ReadError,
  MAX_DOM_ELEMENTS,
  READ_ERROR_CODES,
  type ExtractedDocument,
  type ReadErrorCode,
} from "./read-types.ts";

function parseResult(value: unknown): ExtractedDocument {
  if (typeof value !== "object" || !value)
    throw new ReadError("PARSE_ERROR", "The parser returned an invalid result.");
  const message = value as Record<string, unknown>;
  if (message.ok === false) {
    const code = READ_ERROR_CODES.includes(message.code as ReadErrorCode)
      ? (message.code as ReadErrorCode)
      : "PARSE_ERROR";
    throw new ReadError(
      code,
      typeof message.message === "string" ? message.message : "Could not extract the page.",
    );
  }
  const result = message.result as Record<string, unknown> | undefined;
  if (
    message.ok !== true ||
    !result ||
    typeof result.text !== "string" ||
    !["extracted-article", "plain-text"].includes(String(result.contentKind)) ||
    !Array.isArray(result.warnings) ||
    result.warnings.some((warning) => typeof warning !== "string") ||
    ["title", "byline", "publishedAt"].some(
      (key) => result[key] !== undefined && typeof result[key] !== "string",
    )
  ) {
    throw new ReadError("PARSE_ERROR", "The parser returned an invalid result.");
  }
  return result as ExtractedDocument;
}

/** CPU parsing runs outside Pi's main thread and is terminated on cancellation. */
export async function extractDocument(
  input: { bytes: Uint8Array; url: string; contentType: string },
  signal: AbortSignal,
): Promise<ExtractedDocument> {
  if (signal.aborted) throw abortFailure(signal);
  const worker = new workerThreads.Worker(new URL("./extract-worker.mjs", import.meta.url), {
    workerData: { ...input, maxElements: MAX_DOM_ELEMENTS },
    // Plain JavaScript also works from node_modules, where Node will not strip
    // TypeScript. Do not inherit CLI --input-type or custom loaders.
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
  });
  let onAbort: () => void = () => {};
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      onAbort = () => reject(abortFailure(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("message", resolve);
      worker.once("error", () =>
        reject(
          new ReadError("PARSE_ERROR", "The page parser failed or exceeded its resource limits."),
        ),
      );
      worker.once("exit", () =>
        reject(new ReadError("PARSE_ERROR", "The page parser exited without a result.")),
      );
      if (signal.aborted) onAbort();
    });
    return parseResult(value);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await worker.terminate();
  }
}
