/**
 * Cursor bridge (Phases 3–5): ingest identity/coverage, inbox debounce,
 * recent_work grouping, practice filter, held-state derivation + writers,
 * decision ledger, theory-first extractor brief, re-extract coverage.
 * No LLM, no network — faux engines and in-memory stores.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { POST } from "../app/api/cursor/ingest/route.ts";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { createProberTools } from "../src/agent/tools.ts";
import { recentWork } from "../src/core/recent-work.ts";
import {
	appendNewDecisions,
	clearCursorCoverage,
	decisionPracticeItems,
	decisionsFromChains,
	recordCursorDecisions,
} from "../src/core/decisions.ts";
import {
	cursorSourceId,
	cursorTurnFingerprint,
	parseInboxLine,
	recentCursorPracticeSet,
	recentWorkGoal,
	sanitizeConversationId,
	workspaceFolderName,
} from "../src/core/cursor.ts";
import { CURSOR_CONTEXTUALIZATION, CURSOR_EXTRACTOR_INSTRUCTIONS, CURSOR_PREAMBLE } from "../src/agent/subagents/extraction.ts";
import {
	deriveHeldOverlay,
	isRecurrence,
	outcomeFromAssessment,
	practiceOutcomeToHeld,
	recencyWeight,
	HELD_HALF_LIFE_DAYS,
} from "../src/core/held.ts";
import { parseCursorIngestBody } from "../src/server/cursor-ingest.ts";
import { startCursorInboxWatcher } from "../src/server/cursor-inbox.ts";
import { recordPracticeGrade, recordProbeHeld, recordTeachCheck } from "../src/server/held-writers.ts";
import { extraction } from "../src/server/index.ts";
import { stores } from "../src/server/stores.ts";
import type { DecisionRecord, GraphChain, GraphNode, HeldEntry, NotesSource } from "../src/core/contracts.ts";
import type { ChatStore, DecisionStore, GraphStore, HeldStore, JobStore } from "../src/core/ports.ts";

const originalIngest = extraction.ingestCursor;
after(() => {
	extraction.ingestCursor = originalIngest;
});

function node(
	id: string,
	name: string,
	provenance: Array<{ chatId: string; messageId?: string }>,
	createdAt = "2026-10-20T00:00:00.000Z",
): GraphNode {
	return {
		id,
		name,
		statement: `${name} statement`,
		aliases: [],
		createdAt,
		provenance: provenance.map((p) => ({ chatId: p.chatId, messageId: p.messageId ?? "m1" })),
	};
}

function memoryGraph(over: {
	nodes?: GraphNode[];
	chains?: GraphChain[];
	sources?: NotesSource[];
	coverage?: { chatId: string; fp: string; tokens: number; foldedAt: string }[];
} = {}): GraphStore {
	const nodes = [...(over.nodes ?? [])];
	const chains = [...(over.chains ?? [])];
	const sources = new Map((over.sources ?? []).map((s) => [s.id, s]));
	const coverage = [...(over.coverage ?? [])];
	const positions = new Map<string, { x: number; y: number }>();
	return {
		appendNode: (n) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n, aliases: [...n.aliases], provenance: [...n.provenance] })),
		appendChain: (c) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: () => {},
		readCheckpoints: () => [],
		appendCoverage: (e) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		upsertSource: (s) => {
			const prev = sources.get(s.id);
			sources.set(s.id, { ...s, extractions: [...(prev?.extractions ?? [])] });
		},
		readSources: () => [...sources.values()].map((s) => ({ ...s, extractions: [...(s.extractions ?? [])] })),
		appendSourceUsage: (id, entry) => {
			const source = sources.get(id);
			if (!source) return;
			source.extractions = [...(source.extractions ?? []), entry];
		},
		readPositions: () => Object.fromEntries([...positions].map(([id, p]) => [id, { ...p }])),
		writePositions: (next) => {
			positions.clear();
			for (const [id, p] of Object.entries(next)) positions.set(id, { x: p.x, y: p.y });
		},
		rewriteLedgers: (next) => {
			if (next.nodes) {
				nodes.length = 0;
				nodes.push(...next.nodes);
			}
			if (next.chains) {
				chains.length = 0;
				chains.push(...next.chains);
			}
			if (next.coverage) {
				coverage.length = 0;
				coverage.push(...next.coverage);
			}
		},
	} as GraphStore;
}

function memoryHeld(): HeldStore & { entries: HeldEntry[] } {
	const entries: HeldEntry[] = [];
	return {
		entries,
		append: (e) => void entries.push(e),
		read: () => [...entries],
	};
}

function memoryDecisions(): DecisionStore & { entries: DecisionRecord[] } {
	const entries: DecisionRecord[] = [];
	return {
		entries,
		append: (e) => void entries.push(e),
		read: () => [...entries],
	};
}

const emptyChat: ChatStore = {
	listChats: () => [],
	getChat: () => undefined,
} as unknown as ChatStore;

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

describe("CursorSource identity", () => {
	it("sanitizes conversation ids for the filesystem and keeps them stable", () => {
		assert.equal(sanitizeConversationId("abc-123"), "abc-123");
		assert.equal(cursorSourceId("abc-123"), "abc-123");
		assert.equal(sanitizeConversationId("a/b\\c:d"), "a_b_c_d");
		assert.equal(sanitizeConversationId("..."), "conversation");
		assert.equal(workspaceFolderName("C:\\Users\\marti\\PROJECT\\CursorLearnharness"), "CursorLearnharness");
		assert.equal(workspaceFolderName("/home/me/proj/foo/"), "foo");
	});
});

describe("ingest body + coverage fingerprints", () => {
	it("rejects a missing conversationId and accepts a well-formed body", () => {
		assert.deepEqual(parseCursorIngestBody({}), { error: "conversationId is required" });
		const parsed = parseCursorIngestBody({
			conversationId: "conv-1",
			workspace: "/proj/foo",
			title: "t",
			turns: [{ generationId: "g1", userText: "u", assistantText: "a", at: "2026-10-26T00:00:00.000Z" }],
		});
		assert.ok(!("error" in parsed));
		if ("error" in parsed) return;
		assert.equal(parsed.conversationId, "conv-1");
		assert.equal(parsed.turns.length, 1);
	});

	it("the same turn fingerprints equal; a text edit does not", () => {
		const turn = { generationId: "g1", userText: "why optimistic?", assistantText: "detect conflicts at commit" };
		assert.equal(cursorTurnFingerprint(turn), cursorTurnFingerprint({ ...turn }));
		assert.notEqual(
			cursorTurnFingerprint(turn),
			cursorTurnFingerprint({ ...turn, assistantText: "detect conflicts at commit." }),
		);
	});
});

describe("POST /api/cursor/ingest", () => {
	it("is idempotent at the route: two identical bodies call ingest twice, the pipeline no-ops the second", async () => {
		const calls: unknown[] = [];
		extraction.ingestCursor = async (input) => {
			calls.push(input);
			return { nodes: calls.length === 1 ? 1 : 0, chains: 0 };
		};
		const body = {
			conversationId: "conv-route",
			turns: [{ userText: "q", assistantText: "a" }],
		};
		const req = () =>
			new Request("http://localhost/api/cursor/ingest", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const a = await POST(req());
		const b = await POST(req());
		assert.equal(a.status, 200);
		assert.equal(b.status, 200);
		assert.deepEqual(await a.json(), { ok: true, stats: { nodes: 1, chains: 0 } });
		assert.deepEqual(await b.json(), { ok: true, stats: { nodes: 0, chains: 0 } });
		assert.equal(calls.length, 2);
	});

	it("400s on invalid JSON", async () => {
		const res = await POST(new Request("http://localhost/api/cursor/ingest", { method: "POST", body: "not-json" }));
		assert.equal(res.status, 400);
	});
});

describe("ingestCursor pipeline — coverage of only new turns", () => {
	it("re-ingesting the same conversation is a no-op; a new turn extracts only that turn", async () => {
		const graphStore = memoryGraph();
		let extractorCalls = 0;
		const views: string[] = [];
		const pipeline = createExtractionPipeline({
			chatStore: stores.chatStore,
			graphStore,
			engineFor: (role) => {
				const faux = createFauxCore({});
				faux.setResponses([
					() => {
						if (role === "extractor") extractorCalls++;
						return fauxAssistantMessage(
							[
								fauxToolCall(
									role === "extractor" ? "submit_findings" : "submit_review",
									role === "extractor"
										? {
												propositions: [
													{
														id: "p1",
														name: "Optimistic concurrency",
														statement:
															"Optimistic concurrency detects write conflicts at commit time rather than locking rows.",
														aliases: [],
														messageId: "g1",
													},
												],
												chains: [],
											}
										: { links: [] },
								),
							],
							{ stopReason: "toolUse" },
						);
					},
				]);
				return { model: faux.getModel(), streamFn: faux.streamSimple };
			},
		});
		const turn1 = {
			generationId: "g1",
			userText: "Should we lock rows?",
			assistantText: "Prefer optimistic concurrency: detect conflicts at commit.",
		};
		const first = await pipeline.ingestCursor({
			conversationId: "conv-pipe",
			workspace: "/proj/db",
			title: "locking",
			turns: [turn1],
		});
		assert.equal(first.nodes, 1);
		assert.equal(extractorCalls, 1);
		const source = graphStore.readSources()[0]!;
		assert.equal(source.kind, "cursor");
		assert.equal(source.id, "conv-pipe");
		assert.equal(source.conversationId, "conv-pipe");
		const importedAt = source.importedAt;

		const second = await pipeline.ingestCursor({
			conversationId: "conv-pipe",
			workspace: "/proj/db",
			title: "locking",
			turns: [turn1],
		});
		assert.deepEqual(second, { nodes: 0, chains: 0 });
		assert.equal(extractorCalls, 1, "already-covered turns do not extract");
		assert.equal(graphStore.readSources()[0]!.importedAt, importedAt);
		assert.equal(graphStore.readSources()[0]!.updatedAt, source.updatedAt);

		const turn2 = {
			generationId: "g2",
			userText: "What about lost updates?",
			assistantText: "A version column rejects stale writes.",
		};
		const thirdPipeline = createExtractionPipeline({
			chatStore: stores.chatStore,
			graphStore,
			engineFor: (role) => {
				const faux = createFauxCore({});
				faux.setResponses([
					(context) => {
						if (role === "extractor") {
							extractorCalls++;
							const messages = (context as { messages?: { role: string; content: string }[] }).messages ?? [];
							const last = [...messages].reverse().find((m) => m.role === "user");
							if (typeof last?.content === "string") views.push(last.content);
						}
						const anchor = views.at(-1)?.match(/TURN \[([^\]]+)\]/)?.[1] ?? "g2";
						return fauxAssistantMessage(
							[
								fauxToolCall(
									role === "extractor" ? "submit_findings" : "submit_review",
									role === "extractor"
										? {
												propositions: [
													{
														id: "p2",
														name: "Version column",
														statement: "A version column rejects stale writes under optimistic concurrency.",
														aliases: [],
														messageId: anchor,
													},
												],
												chains: [],
											}
										: { links: [] },
								),
							],
							{ stopReason: "toolUse" },
						);
					},
				]);
				return { model: faux.getModel(), streamFn: faux.streamSimple };
			},
		});
		const third = await thirdPipeline.ingestCursor({
			conversationId: "conv-pipe",
			workspace: "/proj/db",
			turns: [turn1, turn2],
		});
		assert.equal(third.nodes, 1);
		assert.equal(extractorCalls, 2);
		assert.equal(views.length, 1);
		assert.match(views[0]!, /TURN \[g2\]/);
		assert.doesNotMatch(views[0]!, /TURN \[g1\]/, "covered turns stay out of the extractor view");
		assert.ok(!views[0]!.includes("src/") && !views[0]!.includes(".ts"), "fixture stays conceptual, not a file edit");
	});
});

describe("inbox watcher debounce", () => {
	it("debounces idle per file, skips _-prefixed jsonl, catch-up flushes immediately", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-inbox-"));
		const ingestions: string[] = [];
		const timers: Array<{ id: number; fn: () => void; live: boolean }> = [];
		let nextId = 1;
		let watchCb: (event: string, filename: string | Buffer | null) => void = () => {};
		const watcher = startCursorInboxWatcher({
			inboxDir: dir,
			debounceMs: 1_000,
			ingest: async (input) => {
				ingestions.push(input.conversationId);
			},
			setTimeoutFn: ((fn: () => void) => {
				const id = nextId++;
				timers.push({ id, fn, live: true });
				return id as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout,
			clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => {
				const t = timers.find((x) => x.id === (id as unknown as number));
				if (t) t.live = false;
			}) as typeof clearTimeout,
			watch: (_d, cb) => {
				watchCb = cb as typeof watchCb;
				return { close() {} } as fs.FSWatcher;
			},
		});
		try {
			await watcher.flush();
			assert.equal(ingestions.length, 0);

			fs.writeFileSync(
				path.join(dir, "_skip.jsonl"),
				`${JSON.stringify({ conversation_id: "skip", user_text: "u", assistant_text: "a" })}\n`,
			);
			watchCb("change", "_skip.jsonl");
			assert.equal(timers.filter((t) => t.live).length, 0, "underscore files never arm debounce");

			fs.writeFileSync(
				path.join(dir, "conv-a.jsonl"),
				`${JSON.stringify({ conversation_id: "conv-a", user_text: "u", assistant_text: "a" })}\n`,
			);
			await watcher.flush("conv-a.jsonl");
			assert.deepEqual([...ingestions], ["conv-a"]);

			ingestions.splice(0);
			watchCb("change", "conv-a.jsonl");
			watchCb("change", "conv-a.jsonl");
			const live = timers.filter((t) => t.live);
			assert.equal(live.length, 1, "two change events collapse to one timer");
			await live[0]!.fn();
			assert.deepEqual([...ingestions], ["conv-a"]);
		} finally {
			watcher.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("parseInboxLine drops corrupt rows", () => {
		assert.equal(parseInboxLine("not json"), null);
		assert.equal(parseInboxLine("{}"), null);
		const ok = parseInboxLine(
			JSON.stringify({ conversation_id: "c", user_text: "u", assistant_text: "a", generation_id: "g" }),
		);
		assert.equal(ok?.conversation_id, "c");
		assert.equal(ok?.generation_id, "g");
	});
});

describe("recent_work grouping", () => {
	it("groups by workspace folder, newest project first, drops sources outside the window", () => {
		const now = Date.parse("2026-10-26T12:00:00.000Z");
		const graphStore = memoryGraph({
			nodes: [
				node("n1", "Optimistic concurrency", [{ chatId: "c-new" }]),
				node("n2", "Version column", [{ chatId: "c-new" }]),
				node("n3", "Old idea", [{ chatId: "c-old" }]),
				node("n4", "Other project", [{ chatId: "c-b" }]),
			],
			chains: [
				{
					id: "arg_1",
					premises: ["n1"],
					conclusion: "n2",
					createdAt: "2026-10-25T00:00:00.000Z",
					provenance: [{ chatId: "c-new", messageId: "g1" }],
				},
			],
			sources: [
				{
					id: "c-new",
					filePath: "/proj/db",
					importedAt: "2026-10-20T00:00:00.000Z",
					kind: "cursor",
					conversationId: "c-new",
					workspace: "/proj/db",
					title: "locking",
					updatedAt: "2026-10-25T00:00:00.000Z",
				},
				{
					id: "c-old",
					filePath: "/proj/db",
					importedAt: "2026-09-01T00:00:00.000Z",
					kind: "cursor",
					conversationId: "c-old",
					workspace: "/proj/db",
					updatedAt: "2026-09-02T00:00:00.000Z",
				},
				{
					id: "c-b",
					filePath: "/proj/web",
					importedAt: "2026-10-24T00:00:00.000Z",
					kind: "cursor",
					conversationId: "c-b",
					workspace: "/proj/web",
					updatedAt: "2026-10-24T00:00:00.000Z",
				},
			],
		});
		const projects = recentWork({ chatStore: emptyChat, graphStore }, 7, now);
		assert.deepEqual(
			projects.map((p) => p.project),
			["db", "web"],
		);
		assert.equal(projects[0]!.sources[0]!.id, "c-new");
		assert.deepEqual(
			projects[0]!.sources[0]!.propositions.map((p) => p.name),
			["Optimistic concurrency", "Version column"],
		);
		assert.equal(projects[0]!.sources[0]!.decisions[0]!.conclusionName, "Version column");
		assert.ok(!projects.some((p) => p.sources.some((s) => s.id === "c-old")));
		const goal = recentWorkGoal(projects);
		assert.match(goal, /decisions and architecture/);
		assert.match(goal, /db/);
		assert.match(goal, /Optimistic concurrency/);
		assert.deepEqual(projects[0]!.sources[0]!.ledgerDecisions, []);
	});
});

describe("practice filter", () => {
	it("chainsForSelection over recent Cursor nodes drops older and non-Cursor propositions", () => {
		const now = Date.parse("2026-10-26T12:00:00.000Z");
		const nodes = [
			node("n1", "Recent", [{ chatId: "c-new" }]),
			node("n2", "Also recent", [{ chatId: "c-new" }]),
			node("n3", "Notes", [{ chatId: "src_notes" }]),
			node("n4", "Stale cursor", [{ chatId: "c-old" }]),
		];
		const chains: GraphChain[] = [
			{
				id: "arg_recent",
				premises: ["n1"],
				conclusion: "n2",
				createdAt: "2026-10-25T00:00:00.000Z",
				provenance: [{ chatId: "c-new", messageId: "g1" }],
			},
			{
				id: "arg_notes",
				premises: ["n3"],
				conclusion: "n3",
				createdAt: "2026-10-25T00:00:00.000Z",
				provenance: [{ chatId: "src_notes", messageId: "" }],
			},
		];
		const cursorSources = {
			"c-new": { updatedAt: "2026-10-25T00:00:00.000Z" },
			"c-old": { updatedAt: "2026-09-01T00:00:00.000Z" },
		};
		const set = recentCursorPracticeSet(nodes, chains, cursorSources, 7, now);
		assert.deepEqual(
			set.nodes.map((n) => n.id).sort(),
			["n1", "n2"],
		);
		assert.equal(set.chains.length, 1);
		assert.equal(set.chains[0]!.id, "arg_recent");
		assert.ok(!set.chains.some((c) => c.id === "arg_notes"));
	});
});

describe("held-state", () => {
	it("append-only writer records probe/check/practice and never mutates graph nodes", () => {
		const held = memoryHeld();
		const graphStore = memoryGraph({
			nodes: [node("n1", "Optimistic concurrency", [{ chatId: "c1" }])],
		});
		const before = graphStore.readNodes();
		recordProbeHeld(held, graphStore, {
			strands: [{ strand: "Optimistic concurrency", assessment: "solid — can explain the tradeoff" }],
		});
		recordTeachCheck(held, "n1", {
			correct: false,
			dontKnow: false,
			answeredAt: "2026-10-26T00:00:00.000Z",
			confidence: 40,
		} as never);
		recordPracticeGrade(held, ["n1"], "solvedWithHints", "needed a nudge");
		recordPracticeGrade(held, ["n1"], "dismissed");
		assert.equal(held.entries.length, 3);
		assert.equal(held.entries[0]!.source, "probe");
		assert.equal(held.entries[0]!.outcome, "held");
		assert.equal(held.entries[1]!.source, "check");
		assert.equal(held.entries[1]!.outcome, "gap");
		assert.equal(held.entries[2]!.source, "practice");
		assert.equal(held.entries[2]!.outcome, "fragile");
		assert.deepEqual(graphStore.readNodes(), before);
		assert.equal(practiceOutcomeToHeld("solved"), "held");
		assert.equal(practiceOutcomeToHeld("movedOn"), "gap");
		assert.equal(practiceOutcomeToHeld("dismissed"), null);
		assert.equal(outcomeFromAssessment("a misconception about locking"), "misconception");
		assert.equal(outcomeFromAssessment("gap — doesn't know the version column"), "gap");
	});

	it("derivation uses latest outcome, recency decay, and recurrence across Cursor sources", () => {
		const now = Date.parse("2026-10-26T00:00:00.000Z");
		const halfLifeAgo = new Date(now - HELD_HALF_LIFE_DAYS * 86_400_000).toISOString();
		const stale = new Date(now - 60 * 86_400_000).toISOString();
		assert.ok(Math.abs(recencyWeight(halfLifeAgo, now) - 0.5) < 0.02);
		const nodes = [node("n1", "Optimistic concurrency", [{ chatId: "c-later" }, { chatId: "c-first" }])];
		const sources: NotesSource[] = [
			{
				id: "c-first",
				filePath: "/proj/db",
				importedAt: "2026-10-01T00:00:00.000Z",
				kind: "cursor",
				conversationId: "c-first",
			},
			{
				id: "c-later",
				filePath: "/proj/db",
				importedAt: "2026-10-20T00:00:00.000Z",
				kind: "cursor",
				conversationId: "c-later",
			},
		];
		const heldAt = "2026-10-10T00:00:00.000Z";
		const held: HeldEntry = { nodeId: "n1", at: heldAt, source: "probe", outcome: "held" };
		assert.equal(isRecurrence(nodes[0]!, held, sources), true);
		const sameSessionGrow: NotesSource[] = [
			{
				id: "c-first",
				filePath: "/proj/db",
				importedAt: "2026-10-01T00:00:00.000Z",
				kind: "cursor",
				conversationId: "c-first",
				updatedAt: "2026-10-22T00:00:00.000Z",
			},
		];
		assert.equal(
			isRecurrence(node("n1", "X", [{ chatId: "c-first" }]), held, sameSessionGrow),
			false,
			"the same conversation growing is not a recurrence",
		);
		const overlay = deriveHeldOverlay(
			[
				{ nodeId: "n1", at: stale, source: "probe", outcome: "held" },
				{ nodeId: "n1", at: heldAt, source: "check", outcome: "gap" },
			],
			nodes,
			sources,
			now,
		);
		assert.equal(overlay.n1?.outcome, "gap");
		assert.equal(overlay.n1?.recurrence, false, "latest outcome is gap, not held — no recurrence");
		const heldOverlay = deriveHeldOverlay([held], nodes, sources, now);
		assert.equal(heldOverlay.n1?.outcome, "held");
		assert.equal(heldOverlay.n1?.recurrence, true);
		const dueOverlay = deriveHeldOverlay(
			[{ nodeId: "n1", at: stale, source: "probe", outcome: "held" }],
			nodes,
			sameSessionGrow,
			now,
		);
		assert.equal(dueOverlay.n1?.due, true);
	});

	it("held_state reports a gap on the next read and marks solid held as skip", async () => {
		const graphStore = memoryGraph({
			nodes: [node("n-gap", "Version column", [{ chatId: "c1" }]), node("n-held", "Optimistic concurrency", [{ chatId: "c1" }])],
		});
		const held = memoryHeld();
		held.append({ nodeId: "n-gap", at: new Date().toISOString(), source: "probe", outcome: "gap" });
		held.append({ nodeId: "n-held", at: new Date().toISOString(), source: "check", outcome: "held" });
		const tools = createProberTools({
			chatId: "chat",
			chatStore: emptyChat,
			deliver: () => {},
			jobStore: stubJobStore,
			spawn: () => {},
			graphStore,
			heldStore: held,
		});
		const out = (await tools.held_state!.execute!("tc", { nodeIds: ["n-gap", "n-held"] })).details as string;
		assert.match(out, /n-gap: gap/);
		assert.match(out, /n-held: held \[skip \(solid\)\]/);
	});
});

describe("Cursor extractor brief — theory and decisions", () => {
	it("the Cursor prompt keeps theory/decisions/architecture/tools and leaves out UI how-tos", () => {
		assert.match(CURSOR_PREAMBLE, /concepts and decisions, not file edits/);
		assert.match(CURSOR_CONTEXTUALIZATION, /decision is a chain/);
		assert.match(CURSOR_CONTEXTUALIZATION, /premises are the constraints/);
		assert.match(CURSOR_CONTEXTUALIZATION, /switch to it/);
		assert.match(CURSOR_CONTEXTUALIZATION, /Leave out UI widget how-tos/);
		assert.match(CURSOR_CONTEXTUALIZATION, /CSS and layout/);
		assert.match(CURSOR_CONTEXTUALIZATION, /how would you render X/);
		assert.ok(CURSOR_EXTRACTOR_INSTRUCTIONS.includes(CURSOR_CONTEXTUALIZATION));
		assert.match(CURSOR_EXTRACTOR_INSTRUCTIONS, /theory, decisions, alternatives, architecture/);
		assert.doesNotMatch(CURSOR_EXTRACTOR_INSTRUCTIONS, /DROP:/);
	});
});

describe("decision ledger", () => {
	it("append-only writer skips a duplicate (sourceId, question, chosen)", () => {
		const store = memoryDecisions();
		const record: DecisionRecord = {
			id: "dec_1",
			at: "2026-10-26T00:00:00.000Z",
			project: "PreVision",
			sourceId: "conv-pv",
			question: "How should we persist the session?",
			chosen: "Optimistic concurrency",
			alternatives: [
				{
					option: "Pessimistic locking",
					strengths: "Prevents conflicts up front",
					switchWhen: "If write contention is high and lost updates are costly",
				},
			],
			reasons: ["Conflicts are rare."],
			nodeIds: { chosen: "n1", premises: ["n0"], alternatives: ["n2"] },
		};
		assert.equal(appendNewDecisions(store, [record]), 1);
		assert.equal(appendNewDecisions(store, [{ ...record, id: "dec_2", at: "2026-10-27T00:00:00.000Z" }]), 0);
		assert.equal(store.entries.length, 1);
	});

	it("a comparing session writes a decision with the rejected option and switch condition", async () => {
		const graphStore = memoryGraph();
		const decisions = memoryDecisions();
		const pipeline = createExtractionPipeline({
			chatStore: stores.chatStore,
			graphStore,
			decisionStore: decisions,
			engineFor: (role) => {
				const faux = createFauxCore({});
				faux.setResponses([
					() =>
						fauxAssistantMessage(
							[
								fauxToolCall(
									role === "extractor" ? "submit_findings" : "submit_review",
									role === "extractor"
										? {
												propositions: [
													{
														id: "p_opt",
														name: "Optimistic concurrency",
														statement: "Detect write conflicts at commit time rather than locking rows.",
														aliases: [],
														messageId: "g1",
													},
													{
														id: "p_pes",
														name: "Pessimistic locking",
														statement:
															"Pessimistic locking is good when contention is high; switch to it if lost updates are costly.",
														aliases: [],
														messageId: "g1",
													},
													{
														id: "p_rare",
														name: "Rare conflicts",
														statement: "Write conflicts are rare in this workload.",
														aliases: [],
														messageId: "g1",
													},
												],
												chains: [{ premises: ["p_rare"], conclusion: "p_opt" }],
												decisions: [
													{
														question: "How should we persist concurrent edits?",
														chosen: "p_opt",
														alternatives: [
															{
																id: "p_pes",
																strengths: "Prevents conflicts up front",
																switchWhen: "If write contention is high and lost updates are costly",
															},
														],
														reasons: ["p_rare"],
													},
												],
											}
										: { links: [] },
								),
							],
							{ stopReason: "toolUse" },
						),
				]);
				return { model: faux.getModel(), streamFn: faux.streamSimple };
			},
		});
		const stats = await pipeline.ingestCursor({
			conversationId: "conv-pv",
			workspace: "C:\\Users\\marti\\PROJECT\\PreVision",
			title: "locking",
			turns: [
				{
					generationId: "g1",
					userText: "Lock rows or detect conflicts at commit?",
					assistantText: "Prefer optimistic concurrency; switch to locks if contention is high.",
				},
			],
		});
		assert.equal(stats.nodes, 3);
		assert.equal(stats.chains, 1);
		assert.equal(decisions.entries.length, 1);
		const rec = decisions.entries[0]!;
		assert.equal(rec.project, "PreVision");
		assert.equal(rec.question, "How should we persist concurrent edits?");
		assert.equal(rec.chosen, "Optimistic concurrency");
		assert.equal(rec.alternatives[0]!.option, "Pessimistic locking");
		assert.match(rec.alternatives[0]!.switchWhen, /contention is high/);
		assert.ok(rec.nodeIds.chosen?.startsWith("n_"));
		assert.equal(rec.nodeIds.premises.length, 1);

		const again = await pipeline.ingestCursor({
			conversationId: "conv-pv",
			workspace: "C:\\Users\\marti\\PROJECT\\PreVision",
			turns: [
				{
					generationId: "g1",
					userText: "Lock rows or detect conflicts at commit?",
					assistantText: "Prefer optimistic concurrency; switch to locks if contention is high.",
				},
			],
		});
		assert.deepEqual(again, { nodes: 0, chains: 0 });
		assert.equal(decisions.entries.length, 1, "covered turns do not append a second decision");
	});

	it("without an explicit decisions field, a new Cursor chain still becomes a ledger line", () => {
		const store = memoryDecisions();
		const nodes = [
			node("n1", "Rare conflicts", [{ chatId: "c1" }]),
			node("n2", "Optimistic concurrency", [{ chatId: "c1" }]),
		];
		const wrote = recordCursorDecisions({
			store,
			project: "PreVision",
			sourceId: "c1",
			findings: { propositions: [], chains: [] },
			mapping: new Map(),
			appendedChains: [{ id: "arg_1", premises: ["n1"], conclusion: "n2" }],
			nodes,
			at: "2026-10-26T00:00:00.000Z",
		});
		assert.equal(wrote, 1);
		assert.equal(store.entries[0]!.chosen, "Optimistic concurrency");
		assert.equal(store.entries[0]!.question, "Why Optimistic concurrency?");
		assert.deepEqual(store.entries[0]!.nodeIds.premises, ["n1"]);
		assert.equal(decisionsFromChains([{ id: "arg_1", premises: ["n1"], conclusion: "n2" }], nodes, { project: "p", sourceId: "c1" })[0]!.chosen, "Optimistic concurrency");
	});
});

describe("decision practice + recent_work ledger", () => {
	it("practice items are why / what-if / compare / architecture / theory — not what the code does", () => {
		const record: DecisionRecord = {
			id: "dec_pv",
			at: "2026-10-26T00:00:00.000Z",
			project: "PreVision",
			sourceId: "conv-pv",
			question: "How should we persist concurrent edits?",
			chosen: "Optimistic concurrency",
			alternatives: [
				{
					option: "Pessimistic locking",
					strengths: "Prevents conflicts up front",
					switchWhen: "If write contention is high and lost updates are costly.",
				},
			],
			reasons: ["Write conflicts are rare."],
			nodeIds: { chosen: "n2", premises: ["n1"], alternatives: ["n3"] },
		};
		const items = decisionPracticeItems(record);
		assert.deepEqual(
			items.map((i) => i.kind),
			["why", "what-if", "compare", "architecture", "theory"],
		);
		assert.match(items[0]!.statement, /Why did you pick Optimistic concurrency over Pessimistic locking/);
		assert.match(items[1]!.statement, /write contention is high/i);
		assert.match(items[2]!.statement, /When is Pessimistic locking the better choice/);
		assert.match(items[3]!.statement, /Where does the responsibility/);
		assert.match(items[4]!.statement, /What assumption does/);
		assert.ok(items.every((i) => !/what does this code do/i.test(i.statement)));
	});

	it("recent_work joins the ledger and the goal leads with decisions", () => {
		const now = Date.parse("2026-10-26T12:00:00.000Z");
		const graphStore = memoryGraph({
			nodes: [node("n1", "Optimistic concurrency", [{ chatId: "c-new" }])],
			sources: [
				{
					id: "c-new",
					filePath: "/proj/PreVision",
					importedAt: "2026-10-20T00:00:00.000Z",
					kind: "cursor",
					conversationId: "c-new",
					workspace: "/proj/PreVision",
					title: "locking",
					updatedAt: "2026-10-25T00:00:00.000Z",
				},
			],
		});
		const decisionStore = memoryDecisions();
		decisionStore.append({
			id: "dec_1",
			at: "2026-10-25T00:00:00.000Z",
			project: "PreVision",
			sourceId: "c-new",
			question: "How should we persist concurrent edits?",
			chosen: "Optimistic concurrency",
			alternatives: [
				{
					option: "Pessimistic locking",
					strengths: "Prevents conflicts up front",
					switchWhen: "If write contention is high",
				},
			],
			reasons: ["Conflicts are rare"],
			nodeIds: { chosen: "n1", premises: [], alternatives: [] },
		});
		const projects = recentWork({ chatStore: emptyChat, graphStore, decisionStore }, 7, now);
		assert.equal(projects[0]!.project, "PreVision");
		assert.equal(projects[0]!.sources[0]!.ledgerDecisions[0]!.chosen, "Optimistic concurrency");
		assert.ok(projects[0]!.sources[0]!.ledgerDecisions[0]!.practice.some((p) => p.kind === "why"));
		const goal = recentWorkGoal(projects);
		assert.match(goal, /decisions and architecture from PreVision/);
		assert.match(goal, /Decisions: Optimistic concurrency/);
	});
});

describe("re-extract coverage fingerprints", () => {
	it("clearCursorCoverage drops only that conversation so the turn extracts again", () => {
		const graphStore = memoryGraph({
			coverage: [
				{ chatId: "conv-pv", fp: "aaa", tokens: 10, foldedAt: "2026-10-25T00:00:00.000Z" },
				{ chatId: "other", fp: "bbb", tokens: 8, foldedAt: "2026-10-25T00:00:00.000Z" },
			],
		});
		assert.equal(clearCursorCoverage(graphStore, "conv-pv"), 1);
		assert.deepEqual(
			graphStore.readCoverage().map((e) => e.chatId),
			["other"],
		);
		assert.equal(clearCursorCoverage(graphStore, "conv-pv"), 0);
	});
});
