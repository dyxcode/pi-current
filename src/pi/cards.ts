import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { SourceItem, SourceStatus } from "../sources/types.ts";
import type { LibraryItem } from "../library/types.ts";

const CARD = "pi-current-local-card";
type Card = { title: string; body: string };
type ReceiptOptions = {
  status?: string;
  sources?: { id: string; name: string; status: string }[];
  references?: { itemId: string; versionId: string }[];
};
const clean = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal controls while preserving tabs and line breaks.
  text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
export const statusLabel = (source: SourceStatus) =>
  !source.enabled ? "disabled" : (source.pause ?? source.problem ?? source.auth);

export const localResultSchema = Type.Object(
  {
    source: Type.String(),
    modelAccess: Type.Literal("local-display-only"),
    count: Type.Integer(),
    status: Type.String(),
    message: Type.String(),
    sources: Type.Optional(
      Type.Array(
        Type.Object(
          { id: Type.String(), name: Type.String(), status: Type.String() },
          { additionalProperties: false },
        ),
      ),
    ),
    references: Type.Optional(
      Type.Array(
        Type.Object(
          { itemId: Type.String(), versionId: Type.String() },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Build model-visible receipts from an explicit field allowlist. */
export function receipt(
  source: string,
  count: number,
  message: string,
  extra: ReceiptOptions = {},
) {
  const result = {
    source,
    modelAccess: "local-display-only" as const,
    count,
    status: extra.status ?? "displayed",
    message: `${message} Content is local-display-only; do not summarize or rank unseen evidence.`,
    ...(extra.sources === undefined
      ? {}
      : { sources: extra.sources.map(({ id, name, status }) => ({ id, name, status })) }),
    ...(extra.references === undefined
      ? {}
      : { references: extra.references.map(({ itemId, versionId }) => ({ itemId, versionId })) }),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    details: result,
  };
}

export function registerLocalCards(pi: ExtensionAPI) {
  const card = (title: string, body: string) =>
    pi.appendEntry<Card>(CARD, { title: clean(title), body: clean(body) });
  const statusCard = (source: SourceStatus) =>
    card(
      `${source.name} · ${statusLabel(source)}`,
      `Last checked: ${source.checkedAt ?? "never"}. Cached status, not a live guarantee.\n${source.pause ? `Access paused: ${source.pause}. Resolve it manually, then explicitly check the connection.\n` : ""}Manage this source in /sources. Login and checking never collect or resume work.`,
    );
  const itemCard = (item: SourceItem | LibraryItem) =>
    card(
      item.title || "Saved content",
      [
        ...("itemId" in item ? [`Item: ${item.itemId} · Version: ${item.versionId}`] : []),
        `Source: ${item.sourceId} · Author: ${item.author ?? "unknown"}`,
        item.url,
        `Retrieved: ${item.retrievedAt} · Completeness: ${item.sourceCompleteness} · Truncated: ${item.truncated}`,
        ...("displayTruncated" in item && item.displayTruncated ? ["Display excerpt only."] : []),
        "Untrusted source evidence. Displayed locally; not supplied to the model.",
        "",
        item.text,
      ].join("\n"),
    );

  pi.registerEntryRenderer<Card>(CARD, (entry, options, theme) => {
    if (!entry.data || typeof entry.data.title !== "string" || typeof entry.data.body !== "string")
      return undefined;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", clean(entry.data.title)), 0, 0));
    const body = clean(entry.data.body);
    box.addChild(
      new Text(
        options.expanded || body.length < 1200
          ? body
          : `${body.slice(0, 1200)}\n[Expand for local evidence]`,
        0,
        0,
      ),
    );
    return box;
  });
  return { card, statusCard, itemCard };
}
