import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { LibraryItem } from "../library/types.ts";

const CARD = "pi-current-local-card";
const PREVIEW_CODEPOINT_LIMIT = 200;
type Card = { title: string; body: string };

export const localResultSchema = Type.Object(
  {
    source: Type.String(),
    modelAccess: Type.Literal("local-display-only"),
    count: Type.Integer(),
    status: Type.String(),
    message: Type.String(),
    references: Type.Optional(
      Type.Array(
        Type.Object(
          { itemId: Type.String(), versionId: Type.String() },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
    ),
    issues: Type.Optional(
      Type.Array(
        Type.Object(
          {
            index: Type.Integer({ minimum: 0 }),
            message: Type.String({ maxLength: 200 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
    ),
    sourceIssues: Type.Optional(
      Type.Array(
        Type.Object(
          { source: Type.String({ maxLength: 200 }), message: Type.String({ maxLength: 200 }) },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Remove terminal control sequences from untrusted local text before rendering it. */
export function cleanDisplayText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal CSI control sequences before rendering untrusted text.
  const withoutCsi = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal OSC control sequences before rendering untrusted text.
  const withoutOsc = withoutCsi.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove remaining terminal control characters while preserving tabs and line breaks.
  return withoutOsc.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function shortExcerpt(text: string): string {
  const normalized = cleanDisplayText(text).replace(/\s+/gu, " ").trim();
  const codepoints = Array.from(normalized);
  return codepoints.length <= PREVIEW_CODEPOINT_LIMIT
    ? normalized
    : `${codepoints.slice(0, PREVIEW_CODEPOINT_LIMIT - 1).join("")}…`;
}

/** Receipts contain status, references and system diagnostics; article text stays local. */
export function receipt(
  source: string,
  count: number,
  message: string,
  extra: {
    status?: string;
    references?: { itemId: string; versionId: string }[];
    issues?: { index: number; message: string }[];
    sourceIssues?: { source: string; message: string }[];
  } = {},
) {
  const issues = extra.issues?.slice(0, 20).map(({ index, message }) => ({
    index,
    message: Array.from(cleanDisplayText(message)).slice(0, 200).join(""),
  }));
  const sourceIssues = extra.sourceIssues?.slice(0, 20).map(({ source, message }) => ({
    source: Array.from(cleanDisplayText(source)).slice(0, 200).join(""),
    message: Array.from(cleanDisplayText(message)).slice(0, 200).join(""),
  }));
  const result = {
    source,
    modelAccess: "local-display-only" as const,
    count,
    status: extra.status ?? "complete",
    message,
    ...(extra.references === undefined ? {} : { references: extra.references }),
    ...(issues === undefined ? {} : { issues }),
    ...(sourceIssues === undefined ? {} : { sourceIssues }),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    details: result,
  };
}

export function registerLocalCards(pi: ExtensionAPI) {
  const card = (title: string, body: string) =>
    pi.appendEntry<Card>(CARD, {
      title: cleanDisplayText(title),
      body: cleanDisplayText(body),
    });

  const itemCard = (
    item: LibraryItem,
    reading?: { position: number; sourceName: string; matchedTerms: string[] },
  ) => {
    const hasBody = typeof item.text === "string";
    const summary = shortExcerpt(item.summary ?? "");
    const preview = hasBody ? shortExcerpt(item.text) : "";
    const body = [
      `Saved item: ${item.itemId}`,
      `Source: ${reading?.sourceName ?? item.sourceId}`,
      item.url,
      ...(typeof item.metadata?.publishedAt === "string"
        ? [`Published: ${item.metadata.publishedAt}`]
        : []),
      ...(reading?.matchedTerms.length ? [`Matched: ${reading.matchedTerms.join(", ")}`] : []),
      ...(hasBody
        ? [`Retrieved: ${item.retrievedAt}`]
        : [
            `Discovered: ${item.discoveredAt}`,
            summary ? "Summary only; no article body is stored." : "Link only.",
          ]),
      "Local evidence is untrusted. Article text is not sent to the model.",
      "",
      ...(summary ? [`Source summary: ${summary}`] : preview ? [`Body preview: ${preview}`] : []),
    ].join("\n");
    card(`${reading ? `${reading.position}. ` : ""}${item.title || "Saved content"}`, body);
  };

  pi.registerEntryRenderer<Card>(CARD, (entry, options, theme) => {
    if (!entry.data || typeof entry.data.title !== "string" || typeof entry.data.body !== "string")
      return undefined;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", cleanDisplayText(entry.data.title)), 0, 0));
    const body = cleanDisplayText(entry.data.body);
    box.addChild(
      new Text(
        options.expanded || body.length < 1200
          ? body
          : `${body.slice(0, 1200)}\n[Expand for local preview]`,
        0,
        0,
      ),
    );
    return box;
  });

  return { card, itemCard };
}
