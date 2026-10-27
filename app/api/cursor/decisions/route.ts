/**
 * GET /api/cursor/decisions?project= — append-only decision ledger, newest first.
 */
import { listCursorDecisions } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const url = new URL(request.url);
	const project = url.searchParams.get("project")?.trim() || undefined;
	return Response.json(listCursorDecisions(project));
}
