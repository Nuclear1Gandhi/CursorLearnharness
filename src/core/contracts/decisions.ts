/**
 * Decision ledger — queryable record of a choice made in a Cursor session.
 * The graph stays propositions + chains; this side ledger is how a decision
 * stays a decision (question, chosen option, alternatives with switch
 * conditions, reasons, graph node ids).
 */

/** One rejected or fallback option: what it is good for, and when to switch. */
export interface DecisionAlternative {
	option: string;
	strengths: string;
	switchWhen: string;
}

/** Graph node ids that ground one decision record. */
export interface DecisionNodeIds {
	/** Chosen-option proposition (the chain conclusion). */
	chosen?: string;
	/** Constraint / reason propositions (the chain premises). */
	premises: string[];
	/** Alternative propositions. */
	alternatives: string[];
	/** Reasoning-chain id when the decision was stored as a chain. */
	chainId?: string;
}

/** One append-only line in data/decisions/decisions.jsonl. */
export interface DecisionRecord {
	id: string;
	at: string;
	project: string;
	sourceId: string;
	question: string;
	chosen: string;
	alternatives: DecisionAlternative[];
	reasons: string[];
	nodeIds: DecisionNodeIds;
}

/** Extractor-local decision (ids are submit-local or existing graph ids). */
export interface ExtractedDecision {
	question: string;
	/** Local or graph id of the chosen-option proposition. */
	chosen: string;
	alternatives: Array<{
		id: string;
		strengths: string;
		switchWhen: string;
	}>;
	/** Local or graph ids of the constraint / reason propositions. */
	reasons: string[];
}

export type DecisionPracticeKind = "why" | "what-if" | "compare" | "architecture" | "theory";

export interface DecisionPracticeItem {
	kind: DecisionPracticeKind;
	statement: string;
	targetNodeIds: string[];
}
