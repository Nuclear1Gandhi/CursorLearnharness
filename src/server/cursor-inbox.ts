/**
 * Inbox watcher: tails ~/LearnHarness/inbox/<conversation_id>.jsonl
 * (LH_INBOX_DIR override). Debounces ~2 minutes of idle per file, then
 * ingests new lines. Catch-up on start. If LearnHarness is not running,
 * the inbox just grows.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { inboxDir } from "../../config.ts";
import { inboxLineToTurn, parseInboxLine, sanitizeConversationId } from "../core/cursor.ts";
import type { CursorIngestInput } from "../core/cursor.ts";

export const DEFAULT_INBOX_DEBOUNCE_MS = 120_000;

export interface InboxWatcherDeps {
	inboxDir?: string;
	debounceMs?: number;
	ingest: (input: CursorIngestInput) => Promise<unknown>;
	now?: () => number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	watch?: typeof fs.watch;
}

export interface InboxWatcher {
	stop: () => void;
	/** Drain one file (or every jsonl) immediately — tests + boot catch-up. */
	flush: (fileName?: string) => Promise<void>;
}

function conversationIdFromName(fileName: string): string | null {
	if (!fileName.endsWith(".jsonl")) return null;
	if (fileName.startsWith("_")) return null;
	return fileName.slice(0, -".jsonl".length);
}

function readTurns(filePath: string): { conversationId: string; workspace?: string; turns: ReturnType<typeof inboxLineToTurn>[] } | null {
	const fileName = path.basename(filePath);
	const fromName = conversationIdFromName(fileName);
	if (!fromName) return null;
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const turns: ReturnType<typeof inboxLineToTurn>[] = [];
	let workspace: string | undefined;
	let conversationId = fromName;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const parsed = parseInboxLine(trimmed);
		if (!parsed) continue;
		conversationId = parsed.conversation_id || conversationId;
		if (!workspace && parsed.workspace_roots?.[0]) workspace = parsed.workspace_roots[0];
		turns.push(inboxLineToTurn(parsed));
	}
	return { conversationId, workspace, turns };
}

export function startCursorInboxWatcher(deps: InboxWatcherDeps): InboxWatcher {
	const dir = deps.inboxDir ?? inboxDir();
	const debounceMs = deps.debounceMs ?? DEFAULT_INBOX_DEBOUNCE_MS;
	const now = deps.now ?? Date.now;
	const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
	fs.mkdirSync(dir, { recursive: true });

	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let stopped = false;
	let watcher: fs.FSWatcher | undefined;

	const ingestFile = async (fileName: string): Promise<void> => {
		if (stopped) return;
		const parsed = readTurns(path.join(dir, fileName));
		if (!parsed || parsed.turns.length === 0) return;
		await deps.ingest({
			conversationId: parsed.conversationId,
			workspace: parsed.workspace,
			turns: parsed.turns,
		});
	};

	const schedule = (fileName: string): void => {
		if (stopped || !conversationIdFromName(fileName)) return;
		const prev = timers.get(fileName);
		if (prev) clearTimeoutFn(prev);
		timers.set(
			fileName,
			setTimeoutFn(() => {
				timers.delete(fileName);
				void ingestFile(fileName).catch((err) => {
					console.error(`[cursor-inbox] ingest ${fileName} failed:`, err);
				});
			}, debounceMs),
		);
		void now;
	};

	const flush = async (fileName?: string): Promise<void> => {
		if (fileName) {
			await ingestFile(fileName);
			return;
		}
		let names: string[] = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (conversationIdFromName(name)) await ingestFile(name);
		}
	};

	try {
		watcher = (deps.watch ?? fs.watch)(dir, (_event, filename) => {
			if (typeof filename === "string") schedule(filename);
			else {
				try {
					for (const name of fs.readdirSync(dir)) schedule(name);
				} catch {
					/* dir vanished */
				}
			}
		});
	} catch (err) {
		console.warn(`[cursor-inbox] watch failed (${dir}); catch-up still runs:`, err);
	}

	void flush().catch((err) => console.error("[cursor-inbox] boot catch-up failed:", err));

	return {
		stop() {
			stopped = true;
			for (const t of timers.values()) clearTimeoutFn(t);
			timers.clear();
			watcher?.close();
		},
		flush,
	};
}

export function inboxFileName(conversationId: string): string {
	return `${sanitizeConversationId(conversationId)}.jsonl`;
}
