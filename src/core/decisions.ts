/**
 * Decision ledger helpers — record construction, practice shapes, and
 * coverage-clear for re-extract. Pure over ports; the one writer lives
 * in src/store/decisions.ts.
 */

import { randomBytes } from "node:crypto";
import type { DecisionPracticeItem, DecisionRecord, ExtractedDecision } from "./contracts/decisions.ts";
import type { GraphChain, GraphNode, SessionFindings } from "./contracts/graph.ts";
import { cursorSourceId } from "./cursor-view.ts";
import type { DecisionStore, GraphStore } from "./ports.ts";

export function newDecisionId(): string {
	return `dec_${randomBytes(6).toString("hex")}`;
}

export function decisionDedupeKey(record: Pick<DecisionRecord, "sourceId" | "question" | "chosen">): string {
	return `${record.sourceId}\0${record.question.trim()}\0${record.chosen.trim()}`;
}

function resolveId(id: string, mapping: ReadonlyMap<string, string>, existing: ReadonlySet<string>): string | undefined {
	return mapping.get(id) ?? (existing.has(id) ? id : undefined);
}

function nameOf(nodes: ReadonlyMap<string, GraphNode>, id: string | undefined, fallback: string): string {
	if (!id) return fallback;
	return nodes.get(id)?.name ?? fallback;
}

function statementOf(nodes: ReadonlyMap<string, GraphNode>, id: string | undefined, fallback: string): string {
	if (!id) return fallback;
	return nodes.get(id)?.statement ?? fallback;
}

/** Lift extractor-local decisions onto graph ids after the merge mapping is known. */
export function resolveExtractedDecisions(
	extracted: ReadonlyArray<ExtractedDecision>,
	mapping: ReadonlyMap<string, string>,
	nodes: ReadonlyArray<GraphNode>,
	meta: { project: string; sourceId: string; at?: string; chainId?: string },
): DecisionRecord[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const existing = new Set(byId.keys());
	const at = meta.at ?? new Date().toISOString();
	const out: DecisionRecord[] = [];
	for (const raw of extracted) {
		const chosenId = resolveId(raw.chosen, mapping, existing);
		const premiseIds = raw.reasons
			.map((id) => resolveId(id, mapping, existing))
			.filter((id): id is string => id !== undefined);
		const altIds: string[] = [];
		const alternatives = raw.alternatives.map((alt) => {
			const id = resolveId(alt.id, mapping, existing);
			if (id) altIds.push(id);
			return {
				option: nameOf(byId, id, alt.id),
				strengths: alt.strengths,
				switchWhen: alt.switchWhen,
			};
		});
		out.push({
			id: newDecisionId(),
			at,
			project: meta.project,
			sourceId: meta.sourceId,
			question: raw.question.trim(),
			chosen: nameOf(byId, chosenId, raw.chosen),
			alternatives,
			reasons: premiseIds.map((id) => statementOf(byId, id, id)),
			nodeIds: {
				chosen: chosenId,
				premises: premiseIds,
				alternatives: altIds,
				chainId: meta.chainId,
			},
		});
	}
	return out;
}

/** A decision is a chain: premises = constraints, conclusion = choice. */
export function decisionsFromChains(
	chains: ReadonlyArray<Pick<GraphChain, "id" | "premises" | "conclusion">>,
	nodes: ReadonlyArray<GraphNode>,
	meta: { project: string; sourceId: string; at?: string },
): DecisionRecord[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const at = meta.at ?? new Date().toISOString();
	return chains.map((chain) => {
		const chosenNode = byId.get(chain.conclusion);
		const premiseNodes = chain.premises.map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
		const chosen = chosenNode?.name ?? chain.conclusion;
		return {
			id: newDecisionId(),
			at,
			project: meta.project,
			sourceId: meta.sourceId,
			question: `Why ${chosen}?`,
			chosen,
			alternatives: [],
			reasons: premiseNodes.map((n) => n.statement),
			nodeIds: {
				chosen: chain.conclusion,
				premises: [...chain.premises],
				alternatives: [],
				chainId: chain.id,
			},
		};
	});
}

/** Append resolved records; skip (sourceId, question, chosen) already present. */
export function appendNewDecisions(store: DecisionStore, records: ReadonlyArray<DecisionRecord>): number {
	const seen = new Set(store.read().map(decisionDedupeKey));
	let wrote = 0;
	for (const record of records) {
		const key = decisionDedupeKey(record);
		if (seen.has(key)) continue;
		store.append(record);
		seen.add(key);
		wrote++;
	}
	return wrote;
}

/** After a Cursor merge: prefer explicit extractor decisions, else each new chain. */
export function recordCursorDecisions(input: {
	store: DecisionStore;
	project: string;
	sourceId: string;
	findings: SessionFindings;
	mapping: ReadonlyMap<string, string>;
	appendedChains: ReadonlyArray<Pick<GraphChain, "id" | "premises" | "conclusion">>;
	nodes: ReadonlyArray<GraphNode>;
	at?: string;
}): number {
	const meta = { project: input.project, sourceId: input.sourceId, at: input.at };
	const fromExtractor = input.findings.decisions?.length
		? resolveExtractedDecisions(input.findings.decisions, input.mapping, input.nodes, meta)
		: [];
	const records =
		fromExtractor.length > 0 ? fromExtractor : decisionsFromChains(input.appendedChains, input.nodes, meta);
	return appendNewDecisions(input.store, records);
}

/** Why / what-if / compare / architecture / theory — Cursor practice default. */
export function decisionPracticeItems(record: DecisionRecord): DecisionPracticeItem[] {
	const alts = record.alternatives;
	const altNames = alts.map((a) => a.option).filter((n) => n.length > 0);
	const firstAlt = alts[0];
	const targets = [
		record.nodeIds.chosen,
		...record.nodeIds.premises,
		...record.nodeIds.alternatives,
	].filter((id): id is string => typeof id === "string" && id.length > 0);

	const whyOver = altNames.length > 0 ? ` over ${altNames.join(" / ")}` : "";
	const items: DecisionPracticeItem[] = [
		{
			kind: "why",
			statement: `Why did you pick ${record.chosen}${whyOver} for ${record.project}? Answer from the constraints.`,
			targetNodeIds: targets,
		},
	];
	if (firstAlt) {
		items.push({
			kind: "what-if",
			statement: `${firstAlt.switchWhen} What do you switch to, and why?`,
			targetNodeIds: targets,
		});
		items.push({
			kind: "compare",
			statement: `When is ${firstAlt.option} the better choice than ${record.chosen}?`,
			targetNodeIds: targets,
		});
	} else {
		items.push({
			kind: "what-if",
			statement: `A constraint behind "${record.question}" flips. What do you switch to, and why?`,
			targetNodeIds: targets,
		});
	}
	items.push({
		kind: "architecture",
		statement: `Where does the responsibility behind "${record.question}" live in ${record.project}, and what breaks if it moves?`,
		targetNodeIds: targets,
	});
	items.push({
		kind: "theory",
		statement: `What assumption does "${record.chosen}" rely on, and why does that method work?`,
		targetNodeIds: targets,
	});
	return items;
}

/** Drop coverage fingerprints for one Cursor conversation so turns extract again. */
export function clearCursorCoverage(graphStore: GraphStore, conversationId: string): number {
	const id = cursorSourceId(conversationId);
	const coverage = graphStore.readCoverage();
	const kept = coverage.filter((entry) => entry.chatId !== id);
	const removed = coverage.length - kept.length;
	if (removed === 0) return 0;
	graphStore.rewriteLedgers({ coverage: kept });
	return removed;
}

export function decisionsForProject(
	records: ReadonlyArray<DecisionRecord>,
	project?: string,
): DecisionRecord[] {
	const filtered = project
		? records.filter((r) => r.project.toLowerCase() === project.toLowerCase())
		: [...records];
	return filtered.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
