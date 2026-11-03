import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { cleanDisplayText } from "./cards.ts";

export type ReaderArticle = { title: string; url: string; text: string };

/** Open an interactive, plain-text reader. The article body never enters Pi's tool result. */
export async function openLocalReader(
  ctx: ExtensionToolContext,
  article: ReaderArticle,
  signal: AbortSignal,
): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI || signal.aborted) return false;

  await ctx.ui.custom<void>((tui, _theme, keybindings, done) => {
    const text = new Text(
      cleanDisplayText(`${article.title}\n${article.url}\n\n${article.text}`),
      1,
      0,
    );
    const footer = new Text("↑/↓ scroll · PgUp/PgDn move by page · Esc or q closes", 1, 0);
    let offset = 0;
    let finished = false;
    const pageRows = (width: number) =>
      Math.max(3, tui.terminal.rows - footer.render(width).length - 2);
    const finish = () => {
      if (finished) return;
      finished = true;
      done();
    };
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });

    return {
      render(width) {
        const lines = text.render(width);
        const size = pageRows(width);
        const end = Math.max(0, lines.length - size);
        offset = Math.min(offset, end);
        const visible = lines.slice(offset, offset + size);
        footer.setText(
          `Lines ${offset + 1}-${Math.min(offset + visible.length, lines.length)} of ${lines.length} · ↑/↓ scroll · PgUp/PgDn · Esc close`,
        );
        return [...visible, ...footer.render(width)];
      },
      handleInput(data) {
        const size = pageRows(tui.terminal.columns);
        if (
          matchesKey(data, "escape") ||
          matchesKey(data, "enter") ||
          data.toLowerCase() === "q" ||
          keybindings.matches(data, "tui.select.cancel")
        ) {
          finish();
          return;
        }
        if (keybindings.matches(data, "tui.altScreen.pageDown")) offset += size;
        else if (keybindings.matches(data, "tui.altScreen.pageUp"))
          offset = Math.max(0, offset - size);
        else if (keybindings.matches(data, "tui.editor.cursorDown")) offset += 1;
        else if (keybindings.matches(data, "tui.editor.cursorUp")) offset = Math.max(0, offset - 1);
        else if (matchesKey(data, "ctrl+end")) offset = Number.MAX_SAFE_INTEGER;
        else if (matchesKey(data, "ctrl+home")) offset = 0;
        else return;
        tui.requestRender();
      },
      invalidate() {
        text.invalidate();
      },
      dispose() {
        signal.removeEventListener("abort", onAbort);
      },
    };
  });

  if (signal.aborted) return false;
  return true;
}
