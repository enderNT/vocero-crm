import { mockGuard } from "@/lib/dev-guard";
import {
  checkKapsoKey,
  getKapsoMockState,
  kapsoMockFailure,
  kapsoUnauthorized,
  newKapsoWebhookId,
  type KapsoMockWebhook,
} from "@/server/dev/kapso-mock-state";

/**
 * 031 — Imitación de la Platform API de Kapso, solo lo que usa el alta del
 * reenvío: `whatsapp/phone_numbers/{id}/webhooks[/{webhookId}]`. Regla real:
 * un `kind: "meta"` por número; un segundo POST meta → 422.
 *
 * Contrato: specs/031-conector-kapso/contracts/mocks.md
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

type Body = {
  whatsapp_webhook?: {
    kind?: string;
    url?: string;
    secret_key?: string;
    active?: boolean;
  };
};

function serialize(w: KapsoMockWebhook) {
  return {
    id: w.id,
    phone_number_id: w.phoneNumberId,
    kind: w.kind,
    url: w.url,
    active: w.active,
    created_at: w.createdAt,
  };
}

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

/** Valida auth y ruta; devuelve el número y el id del webhook, si viene. */
async function resolver(
  req: Request,
  ctx: Params
): Promise<{ response: Response } | { phoneNumberId: string; webhookId?: string }> {
  const guard = mockGuard();
  if (guard) return { response: guard };
  const auth = checkKapsoKey(req);
  if (auth !== "ok") return { response: kapsoUnauthorized(auth) };
  const failure = kapsoMockFailure(req);
  if (failure) return { response: failure };
  const path = (await ctx.params).path;
  const [a, b, phoneNumberId, c, webhookId] = path;
  if (a !== "whatsapp" || b !== "phone_numbers" || !phoneNumberId || c !== "webhooks") {
    return { response: notFound() };
  }
  if (path.length > 5) return { response: notFound() };
  return { phoneNumberId, webhookId };
}

export async function GET(req: Request, ctx: Params) {
  const r = await resolver(req, ctx);
  if ("response" in r) return r.response;
  const state = getKapsoMockState();
  const mine = state.webhooks.filter((w) => w.phoneNumberId === r.phoneNumberId);
  if (r.webhookId) {
    const w = mine.find((x) => x.id === r.webhookId);
    return w ? Response.json({ data: serialize(w) }) : notFound();
  }
  return Response.json({ data: mine.map(serialize) });
}

export async function POST(req: Request, ctx: Params) {
  const r = await resolver(req, ctx);
  if ("response" in r) return r.response;
  if (r.webhookId) return notFound();
  const body = ((await req.json().catch(() => ({}))) as Body).whatsapp_webhook ?? {};
  const kind = body.kind === "meta" ? "meta" : "kapso";
  const url = (body.url ?? "").trim();
  if (!url) {
    return Response.json({ error: "url is required" }, { status: 422 });
  }
  const state = getKapsoMockState();
  if (
    kind === "meta" &&
    state.webhooks.some((w) => w.phoneNumberId === r.phoneNumberId && w.kind === "meta")
  ) {
    return Response.json(
      { error: "Phone number already has a meta webhook" },
      { status: 422 }
    );
  }
  const webhook: KapsoMockWebhook = {
    id: newKapsoWebhookId(),
    phoneNumberId: r.phoneNumberId,
    kind,
    url,
    secretKey: body.secret_key ?? null,
    active: body.active ?? true,
    createdAt: new Date().toISOString(),
  };
  state.webhooks.push(webhook);
  return Response.json(
    { data: { ...serialize(webhook), secret_key: webhook.secretKey } },
    { status: 201 }
  );
}

export async function PATCH(req: Request, ctx: Params) {
  const r = await resolver(req, ctx);
  if ("response" in r) return r.response;
  const w = getKapsoMockState().webhooks.find(
    (x) => x.phoneNumberId === r.phoneNumberId && x.id === r.webhookId
  );
  if (!w) return notFound();
  const body = ((await req.json().catch(() => ({}))) as Body).whatsapp_webhook ?? {};
  if (body.url !== undefined) w.url = body.url;
  if (body.secret_key !== undefined) w.secretKey = body.secret_key;
  if (body.active !== undefined) w.active = body.active;
  return Response.json({ data: serialize(w) });
}

export async function DELETE(req: Request, ctx: Params) {
  const r = await resolver(req, ctx);
  if ("response" in r) return r.response;
  const state = getKapsoMockState();
  const before = state.webhooks.length;
  state.webhooks = state.webhooks.filter(
    (x) => !(x.phoneNumberId === r.phoneNumberId && x.id === r.webhookId)
  );
  return state.webhooks.length < before ? new Response(null, { status: 204 }) : notFound();
}
