/**
 * Held-state derivation — read-time only. The ledger is append-only
 * (HeldStore); this module never writes. Recency decay is exponential
 * with a 14-day half-life (plan default: recency, not spaced repetition).
 *
 * Recurrence: a proposition that was held, then re-extracted from a
 * later Cursor conversation (a different source whose importedAt is
 * after the held entry).
 */

import type { GraphNode, HeldEntry, HeldNodeOverlay, NotesSource } from "./contracts/graph.ts";
import { isCursorSource } from "./contracts/graph.ts";

export const HELD_HALF_LIFE_DAYS = 14;
/** Weight below this → the latest outcome is stale (due). */
export const HELD_DUE_WEIGHT = 0.25;

export function recencyWeight(at: string, nowMs: number): number {
	const t = Date.parse(at);
	if (!Number.isFinite(t)) return 0;
	const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
	return Math.exp((-ageDays * Math.LN2) / HELD_HALF_LIFE_DAYS);
}

/** Latest entry per node (append order — last write wins). */
export function latestHeldByNode(entries: ReadonlyArray<HeldEntry>): Map<string, HeldEntry> {
	const out = new Map<string, HeldEntry>();
	for (const e of entries) out.set(e.nodeId, e);
	return out;
}

export function isRecurrence(
	node: Pick<GraphNode, "provenance">,
	held: HeldEntry,
	sources: ReadonlyArray<NotesSource>,
): boolean {
	if (held.outcome !== "held") return false;
	const cursor = new Map(sources.filter(isCursorSource).map((s) => [s.id, s]));
	for (const pt of node.provenance) {
		const src = cursor.get(pt.chatId);
		if (!src) continue;
		if (src.importedAt > held.at) return true;
	}
	return false;
}

export function deriveHeldOverlay(
	entries: ReadonlyArray<HeldEntry>,
	nodes: ReadonlyArray<GraphNode>,
	sources: ReadonlyArray<NotesSource>,
	nowMs: number = Date.now(),
): Record<string, HeldNodeOverlay> {
	const latest = latestHeldByNode(entries);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const out: Record<string, HeldNodeOverlay> = {};
	for (const [nodeId, held] of latest) {
		const node = byId.get(nodeId);
		const weight = recencyWeight(held.at, nowMs);
		out[nodeId] = {
			outcome: held.outcome,
			recurrence: node ? isRecurrence(node, held, sources) : false,
			due: weight < HELD_DUE_WEIGHT,
		};
	}
	return out;
}

/** Map a probe-strand assessment (free-form) onto a held outcome. */
export function outcomeFromAssessment(text: string): HeldEntry["outcome"] {
	const t = text.toLowerCase();
	if (/\bmisconception\b/.test(t)) return "misconception";
	if (/\bfragile\b|\bhesitant\b|\bunsure\b|\bshaky\b/.test(t)) return "fragile";
	if (/\bgap\b|\bdoesn't know\b|\bdoes not know\b|\bno idea\b|\bceiling\b/.test(t)) return "gap";
	if (/\bsolid\b|\breliably\b|\bheld\b/.test(t)) return "held";
	if (/\bwrong\b|\bmiss\b/.test(t)) return "gap";
	return "fragile";
}

export function practiceOutcomeToHeld(
	outcome: "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed",
): HeldEntry["outcome"] | null {
	switch (outcome) {
		case "solved":
			return "held";
		case "solvedWithHints":
			return "fragile";
		case "movedOn":
		case "surrendered":
			return "gap";
		case "dismissed":
			return null;
	}
}
