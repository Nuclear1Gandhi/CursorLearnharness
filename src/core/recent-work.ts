/**
 * recent_work — Cursor sources in a time window, grouped by project
 * (workspace folder name), newest first. Pure derivation over the same
 * ports the snapshot reads.
 */

import { getGraph } from "./graph.ts";
import { isCursorSource } from "./contracts/graph.ts";
import { workspaceFolderName } from "./cursor.ts";
import { decisionPracticeItems } from "./decisions.ts";
import type { GraphDeps } from "./graph.ts";
import type { DecisionRecord, DecisionPracticeItem } from "./contracts/decisions.ts";
import type { GraphNode } from "./contracts/graph.ts";
import type { DecisionStore } from "./ports.ts";

export { recentWorkGoal, recentCursorNodes } from "./cursor.ts";

export interface RecentWorkProposition {
	id: string;
	name: string;
	statement: string;
}

export interface RecentWorkDecision {
	id: string;
	premises: string[];
	conclusion: string;
	conclusionName: string;
}

export interface RecentWorkLedgerDecision {
	id: string;
	question: string;
	chosen: string;
	alternatives: Array<{ option: string; strengths: string; switchWhen: string }>;
	reasons: string[];
	practice: DecisionPracticeItem[];
}

export interface RecentWorkSource {
	id: string;
	title?: string;
	workspace?: string;
	project: string;
	updatedAt: string;
	propositions: RecentWorkProposition[];
	decisions: RecentWorkDecision[];
	ledgerDecisions: RecentWorkLedgerDecision[];
}

export interface RecentWorkProject {
	project: string;
	sources: RecentWorkSource[];
}

function sourceStamp(source: { updatedAt?: string; importedAt: string }): string {
	return source.updatedAt ?? source.importedAt;
}

function nodesForSource(nodes: ReadonlyArray<GraphNode>, sourceId: string): GraphNode[] {
	return nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
}

export function recentWork(
	deps: GraphDeps & { decisionStore?: DecisionStore },
	days: number,
	nowMs: number = Date.now(),
): RecentWorkProject[] {
	const windowMs = Math.max(0, days) * 86_400_000;
	const since = nowMs - windowMs;
	const graph = getGraph(deps.graphStore);
	const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
	const cursorSources = deps.graphStore.readSources().filter(isCursorSource);
	const ledgerBySource = new Map<string, DecisionRecord[]>();
	if (deps.decisionStore) {
		for (const record of deps.decisionStore.read()) {
			const list = ledgerBySource.get(record.sourceId) ?? [];
			list.push(record);
			ledgerBySource.set(record.sourceId, list);
		}
	}
	const byProject = new Map<string, RecentWorkSource[]>();

	for (const source of cursorSources) {
		const stamp = sourceStamp(source);
		const t = Date.parse(stamp);
		if (!Number.isFinite(t) || t < since) continue;
		const ours = nodesForSource(graph.nodes, source.id);
		const ourIds = new Set(ours.map((n) => n.id));
		const decisions: RecentWorkDecision[] = graph.chains
			.filter((c) => c.provenance.some((pt) => pt.chatId === source.id) && ourIds.has(c.conclusion))
			.map((c) => ({
				id: c.id,
				premises: [...c.premises],
				conclusion: c.conclusion,
				conclusionName: nameOf.get(c.conclusion) ?? c.conclusion,
			}));
		const project = workspaceFolderName(source.workspace) ?? source.title ?? source.id;
		const entry: RecentWorkSource = {
			id: source.id,
			title: source.title,
			workspace: source.workspace,
			project,
			updatedAt: stamp,
			propositions: ours
				.map((n) => ({ id: n.id, name: n.name, statement: n.statement }))
				.sort((a, b) => (a.id < b.id ? -1 : 1)),
			decisions,
			ledgerDecisions: (ledgerBySource.get(source.id) ?? [])
				.slice()
				.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
				.map((d) => ({
					id: d.id,
					question: d.question,
					chosen: d.chosen,
					alternatives: d.alternatives.map((a) => ({
						option: a.option,
						strengths: a.strengths,
						switchWhen: a.switchWhen,
					})),
					reasons: [...d.reasons],
					practice: decisionPracticeItems(d),
				})),
		};
		const list = byProject.get(project) ?? [];
		list.push(entry);
		byProject.set(project, list);
	}

	const projects: RecentWorkProject[] = [...byProject.entries()].map(([project, sources]) => ({
		project,
		sources: sources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? -1 : 1)),
	}));
	projects.sort((a, b) => {
		const aNewest = a.sources[0]?.updatedAt ?? "";
		const bNewest = b.sources[0]?.updatedAt ?? "";
		return bNewest.localeCompare(aNewest) || a.project.localeCompare(b.project);
	});
	return projects;
}
