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
			"List recent Cursor sessions that contributed to the knowledge graph, grouped by project " +
			"(workspace folder), newest first. Lead with decisions and architecture: each source lists the " +
			"decision ledger (question, chosen option, alternatives + switch conditions) and practice angles " +
			"(why / what-if / compare / architecture / theory). Use this to open a lesson on those strands — " +
			"never on how a control is displayed or how a file was edited.",
		parameters: recentWorkInput,
		execute: serverExecute("recent_work", recentWorkInput, async ({ days }): Promise<string> => {
			const projects = recentWork(ctx, days);
			if (projects.length === 0) {
				return `No Cursor work in the last ${days} day(s) has been extracted into the knowledge graph yet.`;
			}
			const blocks = projects.map((project) => {
				const srcLines = project.sources.map((s) => {
					const ledger =
						s.ledgerDecisions
							.map((d) => {
								const alts = d.alternatives
									.map((a) => `${a.option} (good for: ${a.strengths}; switch when: ${a.switchWhen})`)
									.join("; ");
								const angles = d.practice.map((p) => `${p.kind}: ${p.statement}`).join(" | ");
								return `      • ${d.question} → ${d.chosen}` +
									(alts ? `\n        alternatives: ${alts}` : "") +
									(angles ? `\n        practice: ${angles}` : "");
							})
							.join("\n") || "      (none in the decision ledger)";
					const arch = s.propositions.map((p) => p.name).join(", ") || "(none yet)";
					const title = s.title ? ` — ${s.title}` : "";
					return `  ${s.updatedAt.slice(0, 10)}${title} [${s.id}]\n    decisions:\n${ledger}\n    architecture and theory: ${arch}`;
				});
				return `${project.project}\n${srcLines.join("\n")}`;
			});
			return (
				`Recent Cursor work (last ${days} day(s)), newest first. Open on decisions and architecture, ` +
				`not UI or file-level implementation.\n\n${blocks.join("\n\n")}`
			);
		}),
	};
}
