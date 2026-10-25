import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type {
  SourceItem,
  SourceStatus,
  SourceDiscovery,
  SourceOperationSpec,
  SourceConnection,
} from "../sources/types.ts";
import type { LibraryItem } from "../library/types.ts";

const CARD = "pi-current-local-card";
const PREVIEW_CODEPOINT_LIMIT = 200;
type Card = { title: string; body: string };
type ReceiptOptions = {
  status?: string;
  sources?: {
    id: string;
    name: string;
    status: string;
    operations?: SourceOperationSpec[];
    connections?: SourceConnection[];
  }[];
  references?: { itemId: string; versionId: string }[];
  pendingRef?: string;
};
const clean = (text: string) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal CSI controls before displaying untrusted text.
  const withoutCsi = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal OSC controls before displaying untrusted text.
  const withoutOsc = withoutCsi.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip control characters while preserving tabs and line breaks.
  return withoutOsc.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
};
const shortExcerpt = (text: string) => {
  const normalized = clean(text).replace(/\s+/gu, " ").trim();
  const codepoints = Array.from(normalized);
  return codepoints.length <= PREVIEW_CODEPOINT_LIMIT
    ? normalized
    : `${codepoints.slice(0, PREVIEW_CODEPOINT_LIMIT - 1).join("")}…`;
};
export const statusLabel = (source: SourceStatus) => {
  if (!source.enabled) return "disabled";
  if (source.connections?.length)
    return [
      ...(source.pause || source.problem ? [`source: ${source.pause ?? source.problem}`] : []),
      ...source.connections.map((connection) => {
        const state = source.connectionStates?.[connection.id];
        return `${connection.name}: ${state?.pause ?? state?.problem ?? state?.auth ?? (connection.login ? "not-connected" : "not-required")}`;
      }),
    ].join(" · ");
  return source.pause ?? source.problem ?? source.auth;
};

export const localResultSchema = Type.Object(
  {
    source: Type.String(),
    modelAccess: Type.Literal("local-display-only"),
    count: Type.Integer(),
    status: Type.String(),
    message: Type.String(),
    pendingRef: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$" })),
    sources: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String(),
            name: Type.String(),
            status: Type.String(),
            operations: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    id: Type.String(),
                    name: Type.String(),
                    kind: StringEnum(["discover", "read", "acquire"] as const),
                    connection: Type.String(),
                    input: Type.Optional(StringEnum(["query", "url"] as const)),
                  },
                  { additionalProperties: false },
                ),
              ),
            ),
            connections: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    id: Type.String(),
                    name: Type.String(),
                    login: Type.Boolean(),
                    check: Type.Boolean(),
                  },
                  { additionalProperties: false },
                ),
              ),
            ),
          },
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
    ...(extra.pendingRef === undefined ? {} : { pendingRef: extra.pendingRef }),
    ...(extra.sources === undefined
      ? {}
      : {
          sources: extra.sources.map(({ id, name, status, operations, connections }) => ({
            id,
            name,
            status,
            ...(operations === undefined
              ? {}
              : {
                  operations: operations.map((value) => ({
                    id: value.id,
                    name: value.name,
                    kind: value.kind,
                    connection: value.connection,
                    ...(value.input ? { input: value.input } : {}),
                  })),
                }),
            ...(connections === undefined
              ? {}
              : {
                  connections: connections.map((value) => ({
                    id: value.id,
                    name: value.name,
                    login: value.login,
                    check: value.check,
                  })),
                }),
          })),
        }),
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
      `Last checked: ${source.checkedAt ?? "never"}. Cached status, not a live guarantee.\n${source.pause ? `Access paused: ${source.pause}. Resolve it manually, then explicitly check the connection.\n` : ""}${(
        source.connections ?? []
      )
        .map((connection) => {
          const state = source.connectionStates?.[connection.id];
          return [
            `${connection.name}: ${state?.auth ?? (connection.login ? "not-connected" : "not-required")}`,
            `Checked: ${state?.checkedAt ?? "never"}`,
            ...(state?.pause ? [`Paused: ${state.pause}`] : []),
            ...(state?.problem ? [`Problem: ${state.problem}`] : []),
          ].join(" · ");
        })
        .join(
          "\n",
        )}\n${(source.operations ?? []).map((value) => `${value.id}: ${value.name} (${value.kind})`).join("\n")}\nManage this source in /sources. Login and checking never collect or resume work.`,
    );
  const itemCard = (item: SourceItem | LibraryItem) => {
    const summary = shortExcerpt(item.summary ?? "");
    const bodyPreview = shortExcerpt(item.text);
    return card(
      item.title || "Saved content",
      [
        ...("itemId" in item ? [`Saved item: ${item.itemId}`] : []),
        `Source: ${item.sourceId}${item.author ? ` · Author: ${item.author}` : ""}`,
        item.url,
        `Retrieved: ${item.retrievedAt}`,
        ...(item.sourceCompleteness === "known-partial" ? ["Source is known to be partial."] : []),
        ...(item.truncated ? ["Returned content is marked truncated."] : []),
        ...("displayTruncated" in item && item.displayTruncated ? ["Display excerpt only."] : []),
        "Local display only; source text is untrusted.",
        "",
        ...(summary
          ? [`Source summary: ${summary}`]
          : bodyPreview
            ? [`Body preview: ${bodyPreview}`]
            : ["No preview text available."]),
      ].join("\n"),
    );
  };

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
  const discoveryCard = (item: SourceDiscovery) => {
    const summary = shortExcerpt(item.summary);
    return card(
      item.title || "Discovered content",
      [
        `Source: ${item.sourceId} · Type: ${item.contentType} · Position: ${item.observedPosition ?? "unknown"}`,
        item.url,
        `Discovered: ${item.discoveredAt}`,
        "Discovery only; body completeness is unknown.",
        "Local display only; source evidence is untrusted.",
        "",
        summary ? `Source summary: ${summary}` : "No source summary available.",
      ].join("\n"),
    );
  };
  return { card, statusCard, itemCard, discoveryCard };
}
