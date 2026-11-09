import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReadingSource } from "../reading/sources.ts";
import { readSources, updateSources } from "../reading/sources.ts";
import { cleanDisplayText } from "./cards.ts";

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

/** Register the local source editor at the singular /source command. */
export function registerSourceMenu(
  pi: ExtensionAPI,
  root: string,
  onChanged: () => Promise<void> = async () => {},
): void {
  pi.registerCommand("source", {
    description: "Enable or disable feeds available for reading discovery",
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

        if (sources.length === 0) {
          context.ui.notify(
            "No reading sources are configured. Ask your agent to add a source, then run /source again.",
            "info",
          );
          return;
        }

        const labels = sources.map(sourceLabel);
        const selectedLabel = await context.ui.select("Reading sources", labels);
        if (selectedLabel === undefined) return;

        const selectedIndex = labels.indexOf(selectedLabel);
        const selected = sources[selectedIndex];
        if (!selected) continue;

        const toggleLabel = selected.enabled ? "Disable source" : "Enable source";
        const action = await context.ui.select(`Source: ${displayName(selected)}`, [
          toggleLabel,
          backLabel,
        ]);
        if (action === undefined) return;
        if (action === backLabel) continue;
        if (action !== "Enable source" && action !== "Disable source") continue;

        const targetEnabled = action === "Enable source";
        let changedSource: ReadingSource | undefined;
        try {
          await updateSources(root, (currentSources) => {
            const current = currentSources.find((source) => source.url === selected.url);
            if (!current || current.enabled === targetEnabled) return currentSources;

            changedSource = current;
            return currentSources.map((source) =>
              source.url === selected.url ? { ...source, enabled: targetEnabled } : source,
            );
          });

          if (!changedSource) continue;

          await onChanged();
          context.ui.notify(
            `${targetEnabled ? "Enabled" : "Disabled"} ${displayName(changedSource)}.`,
            "info",
          );
        } catch (error) {
          context.ui.notify(`Could not update reading sources: ${displayError(error)}`, "error");
        }
      }
    },
  });
}
