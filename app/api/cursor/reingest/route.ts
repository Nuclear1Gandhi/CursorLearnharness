/**
 * POST /api/cursor/reingest — drop coverage fingerprints for one Cursor
 * conversation and extract its inbox file again (theory/decision brief).
 */
import { reextractCursorConversation } from "@/src/server";
import { extraction } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "JSON object required" }, { status: 400 });
	}
	const conversationId =
		typeof body === "object" && body !== null && "conversationId" in body && typeof body.conversationId === "string"
			? body.conversationId
			: "";
	const result = await reextractCursorConversation(conversationId, (input) => extraction.ingestCursor(input));
	if ("error" in result) return Response.json(result, { status: 400 });
	return Response.json(result);
}
