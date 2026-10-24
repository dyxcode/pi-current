import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { canonicalUrl } from "../sources/types.ts";

type Permission =
  | { kind: "login" | "check" | "collect"; source: string; limit?: number }
  | { kind: "read"; url: string; source?: string }
  | { kind: "remove"; itemId: string };
type SourceName = { id: string; name: string };

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
  ): Promise<void> {
    this.clear();
    const revision = this.revision;
    if (event.streamingBehavior || !["interactive", "rpc"].includes(event.source)) return;
    const text = event.text.trim();
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

  take(kind: "login" | "check" | "collect", source: string, limit?: number): void {
    if (
      !this.permission ||
      this.permission.kind !== kind ||
      !("source" in this.permission) ||
      this.permission.source !== source
    ) {
      throw new Error(
        kind === "collect" ? "COLLECTION_NOT_REQUESTED" : "SOURCE_ACTION_NOT_REQUESTED",
      );
    }
    if (kind === "collect" && (limit ?? 5) > (this.permission.limit ?? 0))
      throw new Error("COLLECTION_LIMIT");
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
