/**
 * Cursor ingest transport helpers. The pipeline's ingestCursor is the
 * writer; routes call it through the server barrel.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { inboxDir } from "../../config.ts";
import type { CursorIngestInput, CursorTurn } from "../core/cursor.ts";
import { inboxLineToTurn, parseInboxLine, sanitizeConversationId } from "../core/cursor.ts";
import { clearCursorCoverage, decisionsForProject } from "../core/decisions.ts";
import { recentWork, recentWorkGoal } from "../core/recent-work.ts";
import type { EmissionStats } from "../core/contracts.ts";
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

export function listCursorDecisions(project?: string) {
	return { decisions: decisionsForProject(stores.decisionStore.read(), project) };
}

function readInboxTurns(conversationId: string): CursorIngestInput | { error: string } {
	const id = sanitizeConversationId(conversationId);
	const filePath = path.join(inboxDir(), `${id}.jsonl`);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return { error: `inbox file not found: ${id}.jsonl` };
	}
	const turns: CursorTurn[] = [];
	let workspace: string | undefined;
	let resolved = conversationId;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const parsed = parseInboxLine(trimmed);
		if (!parsed) continue;
		resolved = parsed.conversation_id || resolved;
		if (!workspace && parsed.workspace_roots?.[0]) workspace = parsed.workspace_roots[0];
		turns.push(inboxLineToTurn(parsed));
	}
	if (turns.length === 0) return { error: "inbox file has no usable turns" };
	return { conversationId: resolved, workspace, turns };
}

export function loadInboxIngestInput(conversationId: string): CursorIngestInput | { error: string } {
	const trimmed = conversationId.trim();
	if (trimmed.length === 0) return { error: "conversationId is required" };
	return readInboxTurns(trimmed);
}

/** Clear coverage fingerprints for a conversation, then ingest the inbox file again. */
export async function reextractCursorConversation(
	conversationId: string,
	ingest: (input: CursorIngestInput) => Promise<EmissionStats>,
): Promise<{ ok: true; cleared: number; stats: { nodes: number; chains: number } } | { error: string }> {
	const inbox = loadInboxIngestInput(conversationId);
	if ("error" in inbox) return inbox;
	const cleared = clearCursorCoverage(stores.graphStore, inbox.conversationId);
	const stats = await ingest(inbox);
	return { ok: true, cleared, stats: { nodes: stats.nodes, chains: stats.chains ?? 0 } };
}
