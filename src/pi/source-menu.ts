import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReadingSource } from "../reading/sources.ts";
import { readSources, writeSources } from "../reading/sources.ts";
import { cleanDisplayText } from "./cards.ts";

const addSourceLabel = "Add source";
const backLabel = "Back to sources";

function displayName(source: ReadingSource): string {
  return cleanDisplayText(source.name).replace(/\s+/gu, " ").trim() || "Unnamed source";
}

function sourceLabel(source: ReadingSource, index: number): string {
  const state = source.enabled ? "Enabled" : "Disabled";
  return `${index + 1}. ${displayName(source)} — ${state} — ${cleanDisplayText(source.url)}`;
}

function displayError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unexpected error";
  return Array.from(cleanDisplayText(message).replace(/\s+/gu, " ").trim()).slice(0, 200).join("");
}

async function addSource(
  context: ExtensionCommandContext,
  sources: ReadingSource[],
  root: string,
  onChanged: () => Promise<void>,
): Promise<"continue" | "cancelled"> {
  const name = await context.ui.input("Source name", "For example, MIT Research");
  if (name === undefined) return "cancelled";
  const url = await context.ui.input("Feed URL", "For example, https://example.org/feed.xml");
  if (url === undefined) return "cancelled";

  try {
    await writeSources(root, [...sources, { name, url, enabled: true }]);
    await onChanged();
    const safeName = cleanDisplayText(name).replace(/\s+/gu, " ").trim() || "source";
    context.ui.notify(`Added ${safeName} to reading sources.`, "info");
  } catch (error) {
    context.ui.notify(`Could not add source: ${displayError(error)}`, "error");
  }
  return "continue";
}

/** Register the local source editor at the singular /source command. */
export function registerSourceMenu(
  pi: ExtensionAPI,
  root: string,
  onChanged: () => Promise<void> = async () => {},
): void {
  pi.registerCommand("source", {
    description: "Manage feeds available for reading discovery",
    handler: async (_args: string, context: ExtensionCommandContext): Promise<void> => {
      if (!context.hasUI) {
        context.ui.notify(
          "Use /source in an interactive Pi session to manage reading sources.",
          "warning",
        );
        return;
      }

      while (true) {
        let sources: ReadingSource[];
        try {
          sources = await readSources(root);
        } catch (error) {
          context.ui.notify(
            `Could not read local reading sources: ${displayError(error)}`,
            "error",
          );
          return;
        }

        const labels = sources.map(sourceLabel);
        const selectedLabel = await context.ui.select("Reading sources", [
          ...labels,
          addSourceLabel,
        ]);
        if (selectedLabel === undefined) return;

        if (selectedLabel === addSourceLabel) {
          const result = await addSource(context, sources, root, onChanged);
          if (result === "cancelled") return;
          continue;
        }

        const selectedIndex = labels.indexOf(selectedLabel);
        const selected = sources[selectedIndex];
        if (!selected) continue;

        const toggleLabel = selected.enabled ? "Disable source" : "Enable source";
        const action = await context.ui.select(`Source: ${displayName(selected)}`, [
          toggleLabel,
          "Remove source",
          backLabel,
        ]);
        if (action === undefined) return;
        if (action === backLabel) continue;

        const updated = [...sources];
        if (action === "Remove source") {
          updated.splice(selectedIndex, 1);
        } else if (action === toggleLabel) {
          updated[selectedIndex] = { ...selected, enabled: !selected.enabled };
        } else {
          continue;
        }

        try {
          await writeSources(root, updated);
          await onChanged();
          const result =
            action === "Remove source"
              ? "Removed"
              : toggleLabel === "Disable source"
                ? "Disabled"
                : "Enabled";
          const retained = action === "Remove source" ? " Saved library items are unchanged." : "";
          context.ui.notify(`${result} ${displayName(selected)}.${retained}`, "info");
        } catch (error) {
          context.ui.notify(`Could not update reading sources: ${displayError(error)}`, "error");
        }
      }
    },
  });
}
