/**
 * Cursor ingest transport helpers. The pipeline's ingestCursor is the
 * writer; routes call it through the server barrel.
 */

import type { CursorIngestInput, CursorTurn } from "../core/cursor.ts";
import { recentWork, recentWorkGoal } from "../core/recent-work.ts";
import { stores } from "./stores.ts";

function asTurn(raw: unknown): CursorTurn | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.userText !== "string" || typeof o.assistantText !== "string") return null;
	return {
		generationId: typeof o.generationId === "string" ? o.generationId : undefined,
		at: typeof o.at === "string" ? o.at : undefined,
		userText: o.userText,
		assistantText: o.assistantText,
	};
}

export function parseCursorIngestBody(body: unknown): CursorIngestInput | { error: string } {
	if (typeof body !== "object" || body === null) return { error: "JSON object required" };
	const o = body as Record<string, unknown>;
	if (typeof o.conversationId !== "string" || o.conversationId.trim().length === 0) {
		return { error: "conversationId is required" };
	}
	if (!Array.isArray(o.turns)) return { error: "turns must be an array" };
	const turns: CursorTurn[] = [];
	for (const t of o.turns) {
		const turn = asTurn(t);
		if (!turn) return { error: "each turn needs userText and assistantText" };
		turns.push(turn);
	}
	return {
		conversationId: o.conversationId,
		workspace: typeof o.workspace === "string" ? o.workspace : undefined,
		title: typeof o.title === "string" ? o.title : undefined,
		turns,
	};
}

export function recentCursorWork(days: number) {
	const projects = recentWork(stores, days);
	return { projects, goal: recentWorkGoal(projects) };
}
