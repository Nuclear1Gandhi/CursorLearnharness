/**
 * Held-state writers — the only call sites that append to the ledger.
 * Probe, tagged teach checks, and practice grades. Never writes the graph.
 */

import { fuzzyScore } from "../core/fuzzy.ts";
import { outcomeFromAssessment, practiceOutcomeToHeld } from "../core/held.ts";
import type { HeldEntry, ProbeAssessment } from "../core/contracts.ts";
import type { GraphNode } from "../core/contracts.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";
import type { GraphStore, HeldStore } from "../core/ports.ts";
import { getGraph } from "../core/graph.ts";

function nearestNode(strand: string, nodes: ReadonlyArray<GraphNode>): GraphNode | null {
	let best: { node: GraphNode; score: number } | null = null;
	for (const node of nodes) {
		const score = fuzzyScore(strand, node.name, node.statement, ...node.aliases);
		if (score === null) continue;
		if (!best || score > best.score) best = { node, score };
	}
	return best?.node ?? null;
}

export function recordProbeHeld(heldStore: HeldStore, graphStore: GraphStore, assessment: ProbeAssessment): void {
	const nodes = getGraph(graphStore).nodes;
	const at = new Date().toISOString();
	for (const strand of assessment.strands) {
		const node = nearestNode(strand.strand, nodes);
		if (!node) continue;
		heldStore.append({
			nodeId: node.id,
			at,
			source: "probe",
			outcome: outcomeFromAssessment(strand.assessment),
			words: `${strand.strand}: ${strand.assessment}`,
		});
	}
}

export function recordTeachCheck(
	heldStore: HeldStore,
	nodeId: string,
	answer: QuestionAnswerData,
): void {
	if (!nodeId) return;
	let outcome: HeldEntry["outcome"];
	if (answer.dontKnow) outcome = "gap";
	else if (answer.correct === true) outcome = answer.confidence !== undefined && answer.confidence < 60 ? "fragile" : "held";
	else if (answer.correct === false) outcome = "gap";
	else return;
	heldStore.append({
		nodeId,
		at: answer.answeredAt || new Date().toISOString(),
		source: "check",
		outcome,
		confidence: answer.confidence,
		words: answer.thinking ?? answer.note,
	});
}

export function recordPracticeGrade(
	heldStore: HeldStore,
	nodeIds: ReadonlyArray<string>,
	outcome: "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed",
	verdict?: string,
): void {
	const mapped = practiceOutcomeToHeld(outcome);
	if (!mapped) return;
	const at = new Date().toISOString();
	for (const nodeId of nodeIds) {
		heldStore.append({ nodeId, at, source: "practice", outcome: mapped, words: verdict });
	}
}
