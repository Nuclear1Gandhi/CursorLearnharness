/**
 * Browser-safe Cursor helpers — identity, inbox line shape, recent-work
 * prefill, and the practice source+date filter. Fingerprinting (node:crypto)
 * stays in cursor.ts so the shell barrel never pulls Node builtins.
 */

import { chainsForSelection } from "./chains.ts";

export interface CursorTurn {
	generationId?: string;
	at?: string;
	userText: string;
	assistantText: string;
}

export interface CursorIngestInput {
	conversationId: string;
	workspace?: string;
	title?: string;
	turns: CursorTurn[];
}

/** Inbox JSONL line (one captured Cursor turn). */
export interface CursorInboxLine {
	conversation_id: string;
	generation_id?: string;
	workspace_roots?: string[];
	at?: string;
	user_text: string;
	assistant_text: string;
}

export const RECENT_WORK_DAYS = 7;

/** Filesystem-safe source id: the conversation_id with path separators and
 *  other reserved characters replaced. Stable — the same id always yields
 *  the same sanitized form. */
export function sanitizeConversationId(raw: string): string {
	const trimmed = raw.trim();
	const cleaned = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return "conversation";
	return cleaned.slice(0, 180);
}

/** Last path segment of a workspace root — the project label. */
export function workspaceFolderName(workspace?: string): string | undefined {
	if (!workspace) return undefined;
	const normalized = workspace.replace(/[\\/]+$/, "");
	const parts = normalized.split(/[\\/]/).filter(Boolean);
	return parts.at(-1);
}

export function cursorSourceId(conversationId: string): string {
	return sanitizeConversationId(conversationId);
}

/** Extractor view for one batch of turns. Each turn is labeled TURN [id]
 *  so the session-style messageId anchor copies that id. */
export function cursorBatchView(title: string | undefined, turns: ReadonlyArray<CursorTurn & { id: string }>): string {
	const head = title && title.length > 0 ? `# ${title}\n\n` : "";
	const blocks = turns.map((turn) => {
		const when = turn.at ? `  (${turn.at})` : "";
		return `TURN [${turn.id}]${when}\nLEARNER: ${turn.userText.trim()}\n\nASSISTANT: ${turn.assistantText.trim()}`;
	});
	return head + blocks.join("\n\n");
}

export function inboxLineToTurn(line: CursorInboxLine): CursorTurn {
	return {
		generationId: line.generation_id,
		at: line.at,
		userText: line.user_text,
		assistantText: line.assistant_text,
	};
}

/** Pre-fill text for "Review recent work" — editable before the probe. */
export function recentWorkGoal(
	projects: ReadonlyArray<{
		project: string;
		sources: ReadonlyArray<{
			project: string;
			title?: string;
			propositions: ReadonlyArray<{ name: string }>;
			decisions: ReadonlyArray<{ conclusionName: string }>;
		}>;
	}>,
): string {
	const newest = projects[0]?.sources[0];
	if (!newest) return "Review my recent Cursor work.";
	const names = newest.propositions.slice(0, 6).map((p) => p.name);
	const decided = newest.decisions.slice(0, 3).map((d) => d.conclusionName);
	const bits: string[] = [`Review what I worked on in ${newest.project}`];
	if (newest.title) bits[0] += ` (${newest.title})`;
	if (names.length > 0) bits.push(`Ideas: ${names.join("; ")}`);
	if (decided.length > 0) bits.push(`Decisions: ${decided.join("; ")}`);
	return bits.join(". ") + ".";
}

/** Nodes touched by Cursor sources inside the window. */
export function recentCursorNodes<T extends { provenance: ReadonlyArray<{ chatId: string }> }>(
	nodes: ReadonlyArray<T>,
	cursorSources: Readonly<Record<string, { updatedAt: string }>>,
	days: number,
	nowMs: number = Date.now(),
): T[] {
	const since = new Date(nowMs - Math.max(0, days) * 86_400_000).toISOString();
	return nodes.filter((n) =>
		n.provenance.some((pt) => {
			const src = cursorSources[pt.chatId];
			return src !== undefined && src.updatedAt >= since;
		}),
	);
}

/** Practice problem set: chainsForSelection over recent Cursor nodes. */
export function recentCursorPracticeSet<
	N extends { id: string; provenance: ReadonlyArray<{ chatId: string }> },
	C extends { id: string; premises: string[]; conclusion: string },
>(
	nodes: ReadonlyArray<N>,
	chains: ReadonlyArray<C>,
	cursorSources: Readonly<Record<string, { updatedAt: string }>>,
	days: number,
	nowMs?: number,
): { nodes: N[]; chains: ReturnType<typeof chainsForSelection> } {
	const selected = recentCursorNodes(nodes, cursorSources, days, nowMs);
	return { nodes: selected, chains: chainsForSelection(selected, chains) };
}

export function parseInboxLine(raw: string): CursorInboxLine | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const o = parsed as Record<string, unknown>;
	if (typeof o.conversation_id !== "string" || o.conversation_id.trim().length === 0) return null;
	if (typeof o.user_text !== "string" || typeof o.assistant_text !== "string") return null;
	return {
		conversation_id: o.conversation_id,
		generation_id: typeof o.generation_id === "string" ? o.generation_id : undefined,
		workspace_roots: Array.isArray(o.workspace_roots)
			? o.workspace_roots.filter((r): r is string => typeof r === "string")
			: undefined,
		at: typeof o.at === "string" ? o.at : undefined,
		user_text: o.user_text,
		assistant_text: o.assistant_text,
	};
}
