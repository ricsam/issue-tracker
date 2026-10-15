import type { PluginPublicSettings } from "../../shared/plugins";
import { r5dLaunchUrl, type IssueActionContext } from "./r5d";

export interface BrowserPlugin {
  id: string;
  actions: { id: string; label: string; prepare: (settings: PluginPublicSettings, context: IssueActionContext) => Promise<string> }[];
}
// First-party compiled modules only. Settings never supply executable code.
export const browserPlugins: BrowserPlugin[] = [
  { id: "r5d", actions: [{ id: "implement", label: "Implement with r5d", prepare: r5dLaunchUrl }] },
];
