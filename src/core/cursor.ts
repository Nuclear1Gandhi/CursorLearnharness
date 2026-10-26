/**
 * Cursor-source identity, turn coverage, and the extractor view.
 *
 * Cursor conversations are a third source kind beside chats and notes.
 * The source id is the Cursor conversation_id, sanitized for filesystem
 * use. Coverage reuses core/coverage.ts: each turn becomes a synthetic
 * assistant message whose fingerprint is the ledger key, so re-ingesting
 * the same turn is a no-op and a new turn extracts only itself.
 *
 * Browser-safe helpers live in cursor-view.ts (the shell barrel). This
 * file adds Node fingerprinting for the ingest pipeline.
 */

import { createHash } from "node:crypto";
import { messageFingerprint } from "./coverage.ts";
import type { LhMessage } from "./native-messages.ts";
import { sanitizeConversationId, type CursorTurn } from "./cursor-view.ts";

export * from "./cursor-view.ts";

/** Turn identity: generation_id when present, else a content hash. */
export function cursorTurnId(turn: CursorTurn): string {
	const gen = turn.generationId?.trim();
	if (gen) return sanitizeConversationId(gen);
	const h = createHash("sha256");
	h.update(JSON.stringify([turn.userText, turn.assistantText, turn.at ?? ""]));
	return `turn_${h.digest("hex").slice(0, 16)}`;
}

/** Synthetic assistant message covering BOTH user and assistant prose —
 *  coverage.ts fingerprints teacher-prose assistant messages, so this is
 *  how a Cursor turn reuses the ledger. */
export function cursorTurnAsMessage(turn: CursorTurn): LhMessage {
	const id = cursorTurnId(turn);
	const text = `${turn.userText}\n\n${turn.assistantText}`;
	const timestamp = turn.at ? Date.parse(turn.at) : Date.now();
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
	} as LhMessage;
}

export function cursorTurnFingerprint(turn: CursorTurn): string {
	return messageFingerprint(cursorTurnAsMessage(turn));
}
