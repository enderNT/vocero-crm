import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { apiError, parseBody } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { getKapsoMockState } from "@/server/dev/kapso-mock-state";
import { buildEchoPayload, buildInboundPayload } from "@/server/dev/wa-mock-inbound";
import { nextN } from "@/server/dev/wa-mock-state";
import { firmarComoKapso } from "@/server/kapso/firma";
import { getCredentialsByPhoneNumberId } from "@/server/whatsapp/credentials";

/**
 * 031 — Simula el reenvío de Kapso: arma el payload de Meta (como el wa-mock)
 * y lo entrega a la URL del webhook `meta` dado de alta para ese número en el
 * mock de plataforma, firmado con su secreto en `X-Webhook-Signature`.
 *
 * Contrato: specs/031-conector-kapso/contracts/mocks.md
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  phoneNumberId: z.string().min(1),
  /** Remitente (entrante) o destinatario (con `echo`). */
  from: z.string().min(5),
  name: z.string().optional(),
  text: z.string().optional(),
  waMessageId: z.string().optional(),
  /** Adjunto simulado: `{ type: "image" | "document" | … }`. */
  media: z
    .object({ type: z.string(), id: z.string().optional(), mimeType: z.string().optional() })
    .optional(),
  /** Mensaje mandado a mano desde la app del teléfono (coexistencia). */
  echo: z.boolean().optional(),
  badSignature: z.boolean().optional(),
  noSignature: z.boolean().optional(),
  /** Entrega dos veces el mismo evento. */
  duplicate: z.boolean().optional(),
});

/** La URL de esta misma instancia se llama por loopback, como el wa-mock. */
function loopback(url: string): string {
  const own = getEnv().APP_BASE_URL.replace(/\/$/, "");
  const parsed = new URL(url);
  if (parsed.origin !== own) return url;
  return `http://127.0.0.1:${process.env.PORT ?? "3000"}${parsed.pathname}${parsed.search}`;
}

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  const body = await parseBody(req, schema);
  if (!body.ok) return body.response;
  const input = body.data;

  const webhook = getKapsoMockState().webhooks.find(
    (w) => w.phoneNumberId === input.phoneNumberId && w.kind === "meta" && w.active
  );
  if (!webhook) {
    return apiError(
      409,
      "sin_webhook",
      "Ese número no tiene un webhook tipo meta dado de alta en el mock de Kapso"
    );
  }

  const creds = await getCredentialsByPhoneNumberId(input.phoneNumberId);
  const wabaId = creds?.wabaId ?? "WABA-MOCK";
  const type = input.media?.type ?? "text";
  const media = input.media
    ? {
        mediaId: input.media.id ?? `media-kapso-${nextN()}`,
        mimeType: input.media.mimeType,
      }
    : {};
  const payload = input.echo
    ? buildEchoPayload({
        wabaId,
        phoneNumberId: input.phoneNumberId,
        to: input.from,
        type,
        text: input.text,
        waMessageId: input.waMessageId,
        ...media,
      })
    : buildInboundPayload({
        wabaId,
        phoneNumberId: input.phoneNumberId,
        from: input.from,
        name: input.name,
        type,
        text: input.text,
        waMessageId: input.waMessageId,
        ...media,
      });

  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-idempotency-key": `kapso-mock-${nextN()}`,
    "x-webhook-event": "meta",
  };
  if (!input.noSignature) {
    headers["x-webhook-signature"] = input.badSignature
      ? firmarComoKapso(raw, "secreto-equivocado")
      : firmarComoKapso(raw, webhook.secretKey ?? "");
  }

  const entregas = input.duplicate ? 2 : 1;
  const statuses: number[] = [];
  for (let i = 0; i < entregas; i++) {
    const res = await fetch(loopback(webhook.url), { method: "POST", headers, body: raw });
    statuses.push(res.status);
  }
  return Response.json({ delivered: statuses.every((s) => s === 200), statuses, payload });
}
