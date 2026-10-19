import { after } from "next/server";
import { getEnv } from "@/lib/env";
import { isValidWebhookToken, type WebhookPayload } from "@/server/inbox/webhook";
import { processPayload } from "@/server/inbox/webhook-payload";
import { verificarFirmaKapso } from "@/server/kapso/firma";
import { kapsoDisabledResponse, kapsoEnabled } from "@/server/kapso/flag";

/**
 * 031 — Webhook de WhatsApp vía Kapso: recibe el reenvío tipo `meta` (el
 * payload de Meta tal cual) de los números conectados por Kapso.
 *
 * Capas: bandera (404) → segmento secreto (404) → firma de Kapso (401) →
 * parseo (no-JSON = 200 sin efectos) → 200 inmediato y procesado en after().
 * Solo se procesan los eventos de las conexiones Kapso cuyo secreto firmó.
 *
 * Contrato: specs/031-conector-kapso/contracts/webhook-kapso.md
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ webhookToken: string }> };

export async function POST(req: Request, { params }: Params) {
  if (!kapsoEnabled()) return kapsoDisabledResponse();
  const { webhookToken } = await params;
  if (!isValidWebhookToken(webhookToken, getEnv().META_WEBHOOK_VERIFY_TOKEN)) {
    return new Response(null, { status: 404 });
  }

  const rawBody = await req.text();
  const autorizados = await verificarFirmaKapso(
    rawBody,
    req.headers.get("x-webhook-signature")
  );
  if (autorizados.size === 0) return new Response(null, { status: 401 });

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    // Ilegible: 200 igual, para que Kapso no reintente en bucle.
    return Response.json({ received: true });
  }

  after(async () => {
    try {
      await processPayload(
        payload,
        (c) => c.source === "kapso" && autorizados.has(c.phoneNumberId)
      );
    } catch (err) {
      console.error("[webhook-kapso] error procesando payload:", err);
    }
  });

  return Response.json({ received: true });
}

/** Kapso no hace handshake `hub.challenge`. */
export function GET() {
  return new Response(null, { status: 405 });
}
