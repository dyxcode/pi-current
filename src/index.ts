import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSources } from "./pi/sources.ts";
import { registerWebTools } from "./pi/web-tools.ts";

export default async function piCurrent(pi: ExtensionAPI): Promise<void> {
  registerSources(pi);
  registerWebTools(pi);
}
