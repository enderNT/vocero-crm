import { mockGuard } from "@/lib/dev-guard";
import {
  getKapsoMockState,
  resetKapsoMockState,
} from "@/server/dev/kapso-mock-state";

/**
 * 031 — Inspección y control del mock de Kapso para los self-tests: los
 * webhooks dados de alta (sin secretos) y un fallo programado para la
 * próxima llamada al proxy (`{ failNext: 429 | 503 }`) o `{ reset: true }`.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  const state = getKapsoMockState();
  return Response.json({
    webhooks: state.webhooks.map((w) => ({
      id: w.id,
      phoneNumberId: w.phoneNumberId,
      kind: w.kind,
      url: w.url,
      active: w.active,
      hasSecret: Boolean(w.secretKey),
    })),
    failNext: state.failNext,
    keyRevoked: state.keyRevoked,
  });
}

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  const body = (await req.json().catch(() => ({}))) as {
    reset?: boolean;
    failNext?: number | null;
    keyRevoked?: boolean;
  };
  if (body.reset) resetKapsoMockState();
  if (typeof body.keyRevoked === "boolean") {
    getKapsoMockState().keyRevoked = body.keyRevoked;
  }
  if (body.failNext === 429 || body.failNext === 503 || body.failNext === null) {
    getKapsoMockState().failNext = body.failNext;
  }
  return Response.json({ ok: true });
}
