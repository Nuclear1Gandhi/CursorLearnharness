/**
 * DecisionStore — the ONE writer of data/decisions/decisions.jsonl.
 * Append-only JSONL, same discipline as held.jsonl and the graph ledgers.
 * The graph stays propositions + chains; this ledger is queryable decisions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DECISIONS_FILE } from "../../config.ts";
import type { DecisionAlternative, DecisionRecord } from "../core/contracts.ts";
import type { DecisionStore } from "../core/ports.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isAlternative(v: unknown): v is DecisionAlternative {
	if (!isRecord(v)) return false;
	return typeof v.option === "string" && typeof v.strengths === "string" && typeof v.switchWhen === "string";
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isDecisionRecord(v: unknown): v is DecisionRecord {
	if (!isRecord(v)) return false;
	if (typeof v.id !== "string" || typeof v.at !== "string") return false;
	if (typeof v.project !== "string" || typeof v.sourceId !== "string") return false;
	if (typeof v.question !== "string" || typeof v.chosen !== "string") return false;
	if (!Array.isArray(v.alternatives) || !v.alternatives.every(isAlternative)) return false;
	if (!isStringArray(v.reasons)) return false;
	if (!isRecord(v.nodeIds)) return false;
	if (v.nodeIds.chosen !== undefined && typeof v.nodeIds.chosen !== "string") return false;
	if (!isStringArray(v.nodeIds.premises) || !isStringArray(v.nodeIds.alternatives)) return false;
	if (v.nodeIds.chainId !== undefined && typeof v.nodeIds.chainId !== "string") return false;
	return true;
}

function readRaw(): DecisionRecord[] {
	let raw: string;
	try {
		raw = fs.readFileSync(DECISIONS_FILE, "utf-8");
	} catch {
		return [];
	}
	const out: DecisionRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isDecisionRecord(parsed)) out.push(parsed);
		} catch {
			/* skip corrupt line */
		}
	}
	return out;
}

export const decisionStore: DecisionStore = {
	append(entry: DecisionRecord): void {
		fs.mkdirSync(path.dirname(DECISIONS_FILE), { recursive: true });
		fs.appendFileSync(DECISIONS_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
	},
	read(): DecisionRecord[] {
		return readRaw();
	},
};
