/**
 * POST /api/cursor/ingest — Cursor front door. Local-server auth like the
 * other /api/* routes. Idempotent per turn fingerprint.
 */
import { extraction, parseCursorIngestBody } from "@/src/server";
import {
	ModelsNotConfiguredError,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
} from "@/src/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
	}
	const parsed = parseCursorIngestBody(body);
	if ("error" in parsed) {
		return Response.json({ ok: false, error: parsed.error }, { status: 400 });
	}
	try {
		const stats = await extraction.ingestCursor(parsed);
		return Response.json({ ok: true, stats });
	} catch (err) {
		if (err instanceof ModelsNotConfiguredError) {
			return Response.json(
				{ ok: false, error: err.envelope.error, code: "models_not_configured", missing: err.envelope.missing },
				{ status: 503 },
			);
		}
		if (err instanceof ProviderKeyMissingError) {
			return Response.json(
				{
					ok: false,
					error: err.envelope.error,
					code: PROVIDER_KEY_MISSING_CODE,
					provider: err.envelope.provider,
					slots: err.envelope.slots,
				},
				{ status: 503 },
			);
		}
		return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}
