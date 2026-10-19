import { apiError, withAuth } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { isChannelEnabled } from "@/server/channels/enabled";
import { registerWebhookForNumber } from "@/server/whatsapp/connect";
import {
  getCredentialsByOrg,
  setKapsoWebhookId,
} from "@/server/whatsapp/credentials";
import { registrarReenvio } from "@/server/kapso/webhooks";
import { webhookUrl, webhookVerifyToken } from "@/server/whatsapp/webhook-url";

export const dynamic = "force-dynamic";

/**
 * Datos del webhook (FR-043). El de WhatsApp lo registra el CRM al guardar la
 * conexión; la URL y el verify token siguen a la vista para el backend de una
 * agencia o para pegarlos a mano si el registro automático falla.
 *
 * Los canales opcionales comparten el segmento secreto y el verify token, pero
 * cada uno tiene su ruta: Meta configura el webhook de Messenger y el de
 * Instagram por separado (productos distintos de la misma app), así que aquí
 * viajan las tres URLs y la pantalla de cada canal enseña la suya. Las de un
 * canal apagado van en null: no existen en esta instancia (ADR-001).
 */
export const GET = withAuth(async (session) => {
  const env = getEnv();
  // 031: un número conectado por Kapso recibe por su propia ruta, firmada
  // siempre con el secreto que Vocero generó; Kapso no usa verify token.
  const creds = await getCredentialsByOrg(session.organizationId);
  if (creds?.source === "kapso") {
    const url = webhookUrl("wa-kapso");
    return Response.json({
      provider: "kapso",
      url,
      instagramUrl: isChannelEnabled("instagram") ? webhookUrl("ig") : null,
      messengerUrl: isChannelEnabled("messenger") ? webhookUrl("messenger") : null,
      tiktokUrl: isChannelEnabled("tiktok") ? webhookUrl("tiktok") : null,
      verifyToken: null,
      isHttps: url.startsWith("https://"),
      signatureLayer: true,
      webhookRegistered: Boolean(creds.kapsoWebhookId),
    });
  }
  const url = webhookUrl("wa");
  return Response.json({
    provider: "meta",
    url,
    instagramUrl: isChannelEnabled("instagram") ? webhookUrl("ig") : null,
    messengerUrl: isChannelEnabled("messenger") ? webhookUrl("messenger") : null,
    // 022: la URL que se da de alta en Zernio para los mensajes de TikTok.
    tiktokUrl: isChannelEnabled("tiktok") ? webhookUrl("tiktok") : null,
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    isHttps: url.startsWith("https://"),
    signatureLayer: Boolean(env.META_APP_SECRET),
  });
});

/**
 * Registrar el webhook en Meta con la conexión YA guardada.
 *
 * Guardar ya lo hace; esto es para las conexiones anteriores a ese cambio y
 * para reintentar si Meta falló, sin volver a pegar el token.
 */
export const POST = withAuth(async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  if (!creds) {
    return apiError(
      409,
      "sin_conexion",
      "Primero guarda la conexión de WhatsApp."
    );
  }

  if (creds.source === "kapso") {
    // Reintento con el secreto guardado: no se regenera (el de Kapso dejaría
    // de coincidir con el que quizá se pegó a mano).
    const url = webhookUrl("wa-kapso");
    if (!creds.webhookSecret) {
      return apiError(422, "sin_secreto", "Reconecta el número para generar un secreto nuevo.");
    }
    const alta = await registrarReenvio({
      apiKey: creds.token,
      phoneNumberId: creds.phoneNumberId,
      url,
      secret: creds.webhookSecret,
    });
    if (!alta.ok) {
      const status = alta.code === "kapso_no_disponible" ? 503 : 422;
      // Sin el secreto: ya se mostró al guardar. Si se perdió, se reconecta.
      return Response.json(
        { error: { code: alta.code, message: alta.message }, manual: { url } },
        { status }
      );
    }
    await setKapsoWebhookId(session.organizationId, alta.webhookId);
    return Response.json({ ok: true, provider: "kapso" });
  }

  const resultado = await registerWebhookForNumber({
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    token: creds.token,
    webhookUrl: webhookUrl("wa"),
    verifyToken: webhookVerifyToken(),
  });
  if (!resultado.ok) {
    const status = resultado.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, resultado.code, resultado.message);
  }
  return Response.json(resultado);
});
