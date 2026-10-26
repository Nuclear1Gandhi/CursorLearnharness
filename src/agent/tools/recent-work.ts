import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { recentWork } from "../../core/recent-work.ts";
import type { GraphToolContext } from "./graph.ts";

const recentWorkInput = Type.Object({
	days: Type.Number({
		minimum: 1,
		description: "How many days back to look for Cursor work (e.g. 7).",
	}),
});

export function recentWorkTool(ctx: GraphToolContext): AgentTool<typeof recentWorkInput> {
	return {
		name: "recent_work",
		label: "recent_work",
		description:
			"List recent Cursor coding sessions that contributed to the knowledge graph, grouped by project " +
			"(workspace folder), newest first. Each source lists extracted propositions and decisions (reasoning chains). " +
			"Use this to propose a lesson goal from what the learner actually built, instead of starting blank.",
		parameters: recentWorkInput,
		execute: serverExecute("recent_work", recentWorkInput, async ({ days }): Promise<string> => {
			const projects = recentWork(ctx, days);
			if (projects.length === 0) {
				return `No Cursor work in the last ${days} day(s) has been extracted into the knowledge graph yet.`;
			}
			const blocks = projects.map((project) => {
				const srcLines = project.sources.map((s) => {
					const props = s.propositions.map((p) => p.name).join(", ") || "(none yet)";
					const decisions = s.decisions.map((d) => d.conclusionName).join(", ") || "(none)";
					const title = s.title ? ` — ${s.title}` : "";
					return `  ${s.updatedAt.slice(0, 10)}${title} [${s.id}]\n    propositions: ${props}\n    decisions: ${decisions}`;
				});
				return `${project.project}\n${srcLines.join("\n")}`;
			});
			return `Recent Cursor work (last ${days} day(s)), newest first:\n\n${blocks.join("\n\n")}`;
		}),
	};
}
