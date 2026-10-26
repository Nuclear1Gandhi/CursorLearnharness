/**
 * HeldStore — the ONE writer of data/held/held.jsonl. Append-only JSONL,
 * same discipline as the graph ledgers. Ratings never land on graph nodes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { HELD_FILE } from "../../config.ts";
import type { HeldEntry } from "../core/contracts.ts";
import type { HeldStore } from "../core/ports.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const OUTCOMES = new Set(["held", "fragile", "gap", "misconception"]);
const SOURCES = new Set(["probe", "check", "practice"]);

function isHeldEntry(v: unknown): v is HeldEntry {
	if (!isRecord(v)) return false;
	if (typeof v.nodeId !== "string" || typeof v.at !== "string") return false;
	if (typeof v.source !== "string" || !SOURCES.has(v.source)) return false;
	if (typeof v.outcome !== "string" || !OUTCOMES.has(v.outcome)) return false;
	if (v.confidence !== undefined && typeof v.confidence !== "number") return false;
	if (v.words !== undefined && typeof v.words !== "string") return false;
	return true;
}

function readRaw(): HeldEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(HELD_FILE, "utf-8");
	} catch {
		return [];
	}
	const out: HeldEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isHeldEntry(parsed)) out.push(parsed);
		} catch {
			/* skip corrupt line */
		}
	}
	return out;
}

export const heldStore: HeldStore = {
	append(entry: HeldEntry): void {
		fs.mkdirSync(path.dirname(HELD_FILE), { recursive: true });
		fs.appendFileSync(HELD_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
	},
	read(): HeldEntry[] {
		return readRaw();
	},
};
