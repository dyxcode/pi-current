import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { canonicalUrl } from "../sources/types.ts";
import { operationIntent, type OperationIntent } from "./operation-intent.ts";
import type {
  SourceConnection,
  SourceOperationSpec,
  SourceOperationRequest,
} from "../sources/types.ts";

type Permission =
  | { kind: "login" | "check" | "collect"; source: string; limit?: number; connection?: string }
  | { kind: "read"; url: string; source?: string }
  | { kind: "remove"; itemId: string }
  | ({ kind: "operation"; maxRequests: number } & OperationIntent)
  | { kind: "save"; pendingRef: string };
type SourceName = {
  id: string;
  name: string;
  connections?: SourceConnection[];
  operations?: SourceOperationSpec[];
};

function resolveName(name: string, rows: readonly SourceName[]): string | undefined {
  const normalized = name.trim().toLowerCase();
  const matches = rows.filter(
    (row) => row.id === normalized || row.name.toLowerCase() === normalized,
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/** One request grant, invalidated by new input and owned by the Pi session. */
export class RequestAuthorization {
  private permission: Permission | undefined;
  private revision = 0;

  clear(): void {
    this.permission = undefined;
    this.revision++;
  }

  async capture(
    event: Pick<InputEvent, "text" | "source" | "streamingBehavior">,
    list: () => Promise<readonly SourceName[]>,
    lastPendingRef?: string,
  ): Promise<void> {
    this.clear();
    const revision = this.revision;
    if (event.streamingBehavior || !["interactive", "rpc"].includes(event.source)) return;
    const text = event.text.trim();
    const saving = /^(?:please )?save fetched batch\s+([a-f0-9-]{36})[.!]?$/i.exec(text);
    if (saving || /^(?:please )?save last fetched content[.!]?$/i.test(text)) {
      const pendingRef = saving?.[1]?.toLowerCase() ?? lastPendingRef;
      if (pendingRef) this.permission = { kind: "save", pendingRef };
      return;
    }
    const intent = operationIntent(text);
    if (intent) {
      const rows = await list();
      if (revision !== this.revision) return;
      const source = resolveName(intent.source, rows);
      const spec = rows
        .find((row) => row.id === source)
        ?.operations?.find((value) => value.id === intent.operation);
      if (
        source &&
        spec &&
        (spec.input === "query") === (intent.query !== undefined) &&
        (spec.input === "url") === (intent.url !== undefined) &&
        !(spec.kind === "discover" && intent.save)
      ) {
        this.permission = {
          kind: "operation",
          ...intent,
          source,
          maxRequests: spec.kind === "acquire" ? Math.min(20, 1 + intent.limit * 2) : 1,
        };
      }
      return;
    }
    const connected =
      /^(?:please )?(check|log in to)\s+([a-z][a-z0-9-]*)\s+connection\s+from\s+(.+?)[.!]?$/i.exec(
        text,
      );
    if (connected) {
      const rows = await list();
      if (revision !== this.revision) return;
      const source = resolveName(connected[3]!, rows);
      const connection = connected[2]!;
      const spec = rows
        .find((row) => row.id === source)
        ?.connections?.find((value) => value.id === connection);
      const kind = connected[1]!.toLowerCase() === "check" ? "check" : "login";
      if (source && spec?.[kind]) this.permission = { kind, source, connection };
      return;
    }
    const removal =
      /^(?:(?:please )?delete saved item|(?:请)?删除已保存条目)\s+([a-f0-9-]{36})[。.!]?$/i.exec(
        text,
      );
    if (removal) {
      this.permission = { kind: "remove", itemId: removal[1]!.toLowerCase() };
      return;
    }
    const read =
      /^(?:(?:please )?(?:read|open)|(?:请帮我|帮我|请)?(?:读取|阅读|打开|读一下))\s+(https?:\/\/\S+?)(?:\s+from\s+(.+))?[。！!]?$/i.exec(
        text,
      );
    if (read) {
      let url: string;
      try {
        url = canonicalUrl(read[1]!);
      } catch {
        return;
      }
      if (!read[2]) {
        this.permission = { kind: "read", url };
      } else {
        const source = resolveName(read[2], await list());
        if (source && revision === this.revision) this.permission = { kind: "read", url, source };
      }
      return;
    }
    const login =
      /^(?:(?:please )?(?:log ?in(?: to)?|reconnect)\s+|(?:请帮我|帮我|请)?(?:重新)?(?:登录|连接))(.+?)[。.!！]?$/i.exec(
        text,
      );
    const check =
      /^(?:(?:please )?check\s+|(?:请帮我|帮我|请)?检查(?:一下)?)(.+?)(?:\s+connection|连接|登录)?[。.!！]?$/i.exec(
        text,
      );
    const collect =
      /^(?:please )?(?:collect|fetch)\s+(\d+)\s+items?\s+from\s+(.+?)[.!]?$/i.exec(text) ??
      /^(?:请帮我|帮我|请)?(?:采集|抓取)\s*(\d+)\s*(?:个|条)?\s*(.+?)(?:回答|文章|条目|内容)?[。！!]?$/u.exec(
        text,
      );
    if (!login && !check && !collect) return;
    const rows = await list();
    if (revision !== this.revision) return;
    if (collect) {
      const source = resolveName(collect[2]!, rows);
      const limit = Number(collect[1]);
      if (source && limit >= 1 && limit <= 10) this.permission = { kind: "collect", source, limit };
    } else {
      const source = resolveName((login ?? check)![1]!, rows);
      if (source) this.permission = { kind: login ? "login" : "check", source };
    }
  }

  take(
    kind: "login" | "check" | "collect",
    source: string,
    limit?: number,
    connection?: string,
  ): void {
    if (
      !this.permission ||
      this.permission.kind !== kind ||
      !("source" in this.permission) ||
      this.permission.source !== source ||
      this.permission.connection !== connection
    ) {
      throw new Error(
        kind === "collect" ? "COLLECTION_NOT_REQUESTED" : "SOURCE_ACTION_NOT_REQUESTED",
      );
    }
    if (kind === "collect" && (limit ?? 5) > (this.permission.limit ?? 0))
      throw new Error("COLLECTION_LIMIT");
    this.clear();
  }

  takeOperation(args: {
    source: string;
    operation: string;
    query?: string;
    url?: string;
    limit?: number;
    maxRequests?: number;
    maxCharacters?: number;
    save?: boolean;
  }): { request: SourceOperationRequest; save: boolean } {
    const grant = this.permission;
    let url: string | undefined;
    try {
      url = args.url === undefined ? undefined : canonicalUrl(args.url);
    } catch {
      throw new Error("SOURCE_OPERATION_NOT_REQUESTED");
    }
    if (
      grant?.kind !== "operation" ||
      grant.source !== args.source ||
      grant.operation !== args.operation ||
      grant.query !== args.query?.trim() ||
      grant.url !== url ||
      (args.save !== undefined && args.save !== grant.save)
    ) {
      throw new Error("SOURCE_OPERATION_NOT_REQUESTED");
    }
    const limit = args.limit ?? grant.limit;
    const maxRequests = args.maxRequests ?? grant.maxRequests;
    const maxCharacters = args.maxCharacters ?? 5000;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > grant.limit ||
      !Number.isInteger(maxRequests) ||
      maxRequests < 1 ||
      maxRequests > grant.maxRequests ||
      !Number.isInteger(maxCharacters) ||
      maxCharacters < 1000 ||
      maxCharacters > 50000
    )
      throw new Error("SOURCE_OPERATION_LIMIT");
    this.clear();
    return {
      request: {
        limit,
        maxRequests,
        maxCharacters,
        ...(grant.query === undefined ? {} : { query: grant.query }),
        ...(url === undefined ? {} : { url }),
      },
      save: grant.save,
    };
  }

  takeSave(pendingRef: string): void {
    if (this.permission?.kind !== "save" || this.permission.pendingRef !== pendingRef)
      throw new Error("SOURCE_SAVE_NOT_REQUESTED");
    this.clear();
  }

  takeRead(url: string, source?: string): { url: string; source?: string } {
    const canonical = canonicalUrl(url);
    if (
      this.permission?.kind !== "read" ||
      this.permission.url !== canonical ||
      (this.permission.source && source && this.permission.source !== source)
    ) {
      throw new Error("BROWSER_READ_NOT_REQUESTED");
    }
    const chosen = this.permission.source ?? source;
    this.clear();
    return { url: canonical, ...(chosen === undefined ? {} : { source: chosen }) };
  }

  takeRemove(itemId: string): void {
    if (this.permission?.kind !== "remove" || this.permission.itemId !== itemId)
      throw new Error("LIBRARY_REMOVE_NOT_REQUESTED");
    this.clear();
  }
}
