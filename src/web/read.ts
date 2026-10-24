import { fetchPublicPage } from "./http-page.ts";
import { extractDocument } from "./extract.ts";
import {
  abortFailure,
  READ_TIMEOUT_MS,
  ReadError,
  validateReadInput,
  type ReadResult,
} from "./read-types.ts";

export async function readPage(input: unknown, signal?: AbortSignal): Promise<ReadResult> {
  const request = validateReadInput(input);
  const lifetime = new AbortController();
  const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  if (combined.aborted) throw abortFailure(combined);
  const timer = setTimeout(
    () => lifetime.abort(new ReadError("TIMEOUT", "Page reading exceeded 30 seconds.")),
    READ_TIMEOUT_MS,
  );
  try {
    const page = await fetchPublicPage(request.url, combined);
    const retrievedAt = new Date().toISOString();
    const article = await extractDocument(
      { bytes: page.bytes, url: page.finalUrl, contentType: page.contentType },
      combined,
    );
    if (combined.aborted) throw abortFailure(combined);
    const characters = [...article.text];
    return {
      ...article,
      text: characters.slice(0, request.maxCharacters).join(""),
      requestedUrl: request.url,
      finalUrl: page.finalUrl,
      retrievedAt,
      retrievalMethod: "direct-http",
      contentType: page.contentType,
      sourceCompleteness: page.partial ? "known-partial" : "unknown",
      truncated: characters.length > request.maxCharacters,
    };
  } catch (error) {
    if (combined.aborted) throw abortFailure(combined);
    if (error instanceof ReadError) throw error;
    throw new ReadError("PARSE_ERROR", "Could not read the page.");
  } finally {
    clearTimeout(timer);
    lifetime.abort();
  }
}
