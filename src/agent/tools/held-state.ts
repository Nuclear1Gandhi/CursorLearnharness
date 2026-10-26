import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { getGraph } from "../../core/graph.ts";
import { deriveHeldOverlay } from "../../core/held.ts";
import type { ChatStore, GraphStore, HeldStore } from "../../core/ports.ts";

export interface HeldStateContext {
	chatStore: ChatStore;
	graphStore: GraphStore;
	heldStore: HeldStore;
}

const heldStateInput = Type.Object({
	nodeIds: Type.Optional(
		Type.Array(Type.String(), {
			description: "Node ids to inspect. Omit to read every node that has a held-state entry.",
		}),
	),
});

export function heldStateTool(ctx: HeldStateContext): AgentTool<typeof heldStateInput> {
	return {
		name: "held_state",
		label: "held_state",
		description:
			"Read the learner's held-state for graph nodes: latest outcome (held / fragile / gap / misconception) " +
			"with recency decay, plus recurrences (a held idea that came up again in a later Cursor session). " +
			"Skip solid held strands that are not due and not recurrences; go to gaps, recurrences, and due items.",
		parameters: heldStateInput,
		execute: serverExecute("held_state", heldStateInput, async ({ nodeIds }): Promise<string> => {
			const overlay = deriveHeldOverlay(
				ctx.heldStore.read(),
				getGraph(ctx.graphStore).nodes,
				ctx.graphStore.readSources(),
			);
			const ids = nodeIds && nodeIds.length > 0 ? nodeIds : Object.keys(overlay);
			if (ids.length === 0) return "No held-state has been recorded yet.";
			const lines: string[] = [];
			for (const id of ids) {
				const state = overlay[id];
				if (!state) {
					lines.push(`- ${id}: no held-state recorded`);
					continue;
				}
				const flags = [
					state.recurrence ? "recurrence" : null,
					state.due ? "due" : null,
					state.outcome === "held" && !state.due && !state.recurrence ? "skip (solid)" : null,
				].filter(Boolean);
				lines.push(`- ${id}: ${state.outcome}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`);
			}
			return `Held-state (${ids.length} node(s)):\n${lines.join("\n")}`;
		}),
	};
}
