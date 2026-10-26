/**
 * GET /api/cursor/recent?days=7 — recent Cursor work + a pre-fill goal
 * for "Review recent work".
 */
import { recentCursorWork } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const url = new URL(request.url);
	const raw = Number(url.searchParams.get("days") ?? "7");
	const days = Number.isFinite(raw) && raw > 0 ? raw : 7;
	return Response.json(recentCursorWork(days));
}
