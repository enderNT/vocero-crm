import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  desconectarCanal,
  generateWebhookSecret,
  getCredentialsByOrg,
  saveCredentials,
  setKapsoWebhookId,
  tokenLast4,
} from "@/server/whatsapp/credentials";
import { kapsoEnabled } from "@/server/kapso/flag";
import {
  AVISO_RETIRO_MANUAL,
  registrarReenvio,
  retirarReenvio,
} from "@/server/kapso/webhooks";
import type { Credentials } from "@/server/whatsapp/credentials";
import {
  registerWebhookForNumber,
  testConnection,
  unregisterWebhookForNumber,
} from "@/server/whatsapp/connect";
import {
  webhookPath,
  webhookUrl,
  webhookVerifyToken,
} from "@/server/whatsapp/webhook-url";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  // 031: si la opción Kapso existe en esta instancia (bandera encendida).
  const kapsoAvailable = kapsoEnabled();
  if (!creds) return Response.json({ connection: null, kapsoAvailable });
  return Response.json({
    connection: {
      source: creds.source,
      wabaId: creds.wabaId,
      phoneNumberId: creds.phoneNumberId,
      displayPhoneNumber: creds.displayPhoneNumber,
      verifiedName: creds.verifiedName,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
      // El secreto de firma NUNCA sale en el GET.
      ...(creds.source === "kapso"
        ? {
            kapso: {
              webhookRegistered: Boolean(creds.kapsoWebhookId),
              webhookUrl: webhookUrl("wa-kapso"),
            },
          }
        : {}),
    },
    kapsoAvailable,
  });
});

const putSchema = z.object({
  // 031: por dónde habla el número. Default Meta (lo de siempre).
  source: z.enum(["meta", "kapso"]).default("meta"),
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
  token: z.string().trim().min(1),
});

/**
 * Guarda la conexión: re-valida contra Meta, cifra (FR-040) y registra el
 * webhook de esta instancia en el número.
 *
 * Antes el CRM solo suscribía la app a la WABA y la URL había que pegarla a
 * mano en el panel de Meta. Si Meta rechaza el registro, la conexión YA está
 * guardada y es válida: se avisa en `webhook` y la tarjeta del webhook ofrece
 * reintentar (o pegar la URL a mano, que sigue a la vista).
 */
export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  if (body.data.source === "kapso") {
    if (!kapsoEnabled()) {
      return apiError(404, "kapso_apagado", "El conector Kapso no está encendido en esta instancia");
    }
    return guardarKapso(session.organizationId, body.data);
  }

  const check = await testConnection({
    source: "meta",
    phoneNumberId: body.data.phoneNumberId,
    token: body.data.token,
  });
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }

  // 031 (US5): si el número venía por Kapso, se retira su reenvío antes de
  // guardar (con la llave vieja, que después ya no estará). Best-effort.
  const previa = await getCredentialsByOrg(session.organizationId);
  const retiroOk = previa?.source === "kapso" ? await retirarKapso(previa) : true;

  await saveCredentials({
    organizationId: session.organizationId,
    wabaId: body.data.wabaId,
    phoneNumberId: body.data.phoneNumberId,
    token: body.data.token,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
  });

  const webhook = await registerWebhookForNumber({
    wabaId: body.data.wabaId,
    phoneNumberId: body.data.phoneNumberId,
    token: body.data.token,
    webhookUrl: webhookUrl("wa"),
    verifyToken: webhookVerifyToken(),
  });

  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
    webhook,
    ...(retiroOk ? {} : { aviso: AVISO_RETIRO_MANUAL }),
  });
});

/** Retira el reenvío en Kapso de una conexión previa (US5). */
async function retirarKapso(creds: Credentials): Promise<boolean> {
  // Con la bandera apagada el conector no habla con nadie.
  if (!kapsoEnabled()) return false;
  return retirarReenvio({
    apiKey: creds.token,
    phoneNumberId: creds.phoneNumberId,
    webhookId: creds.kapsoWebhookId,
    url: webhookUrl("wa-kapso"),
  });
}

/**
 * 031 — Guardar una conexión por Kapso: probar con la llave, generar el
 * secreto de firma, guardar (cifrado) y dar de alta el reenvío `meta` en
 * Kapso. No toca el webhook de Meta. Si el alta falla, la conexión queda
 * guardada y la respuesta trae URL y secreto para pegarlos a mano: es la
 * ÚNICA vez que el secreto viaja al navegador.
 */
async function guardarKapso(
  organizationId: string,
  data: { wabaId: string; phoneNumberId: string; token: string }
): Promise<Response> {
  const check = await testConnection({
    source: "kapso",
    phoneNumberId: data.phoneNumberId,
    token: data.token,
  });
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }

  // 031 (US5): lo que dejó la conexión anterior, con sus credenciales viejas.
  // Meta → Kapso: se quita el override del número en Meta. Kapso con otro
  // número: se retira aquel reenvío (el del mismo número se actualiza abajo).
  const previa = await getCredentialsByOrg(organizationId);
  let retiroOk = true;
  if (previa && previa.source !== "kapso") {
    await unregisterWebhookForNumber({
      phoneNumberId: previa.phoneNumberId,
      token: previa.token,
      webhookPath: webhookPath("wa"),
    });
  } else if (previa?.source === "kapso" && previa.phoneNumberId !== data.phoneNumberId) {
    retiroOk = await retirarKapso(previa);
  }

  const secret = generateWebhookSecret();
  await saveCredentials({
    organizationId,
    wabaId: data.wabaId,
    phoneNumberId: data.phoneNumberId,
    token: data.token,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
    source: "kapso",
    webhookSecret: secret,
  });

  const url = webhookUrl("wa-kapso");
  const alta = await registrarReenvio({
    apiKey: data.token,
    phoneNumberId: data.phoneNumberId,
    url,
    secret,
  });
  if (alta.ok) await setKapsoWebhookId(organizationId, alta.webhookId);

  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
    ...(retiroOk ? {} : { aviso: AVISO_RETIRO_MANUAL }),
    webhook: alta.ok
      ? { ok: true, provider: "kapso" }
      : {
          ok: false,
          provider: "kapso",
          code: alta.code,
          message: alta.message,
          manual: { url, secret },
        },
  });
}

/**
 * Desconectar el número. Sin esto, conectar era una calle de un solo
 * sentido: la unicidad del número impedía moverlo a otra instancia y no había
 * pantalla donde soltarlo.
 *
 * Primero quita el override del webhook que puso el guardado —con el token
 * todavía a mano; sin él no se podría— y después borra las credenciales. No
 * borra la bandeja: las conversaciones son de la organización, no de la
 * conexión. Idempotente: sin conexión responde 200 igual.
 */
export const DELETE = withAuth(async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  // 031: la llave de Kapso jamás va a Meta; con Kapso se retira su reenvío.
  let retiroOk = true;
  if (creds?.source === "kapso") {
    retiroOk = await retirarKapso(creds);
  } else if (creds) {
    await unregisterWebhookForNumber({
      phoneNumberId: creds.phoneNumberId,
      token: creds.token,
      webhookPath: webhookPath("wa"),
    });
  }
  await desconectarCanal(session.organizationId);
  return Response.json({
    ok: true,
    ...(retiroOk ? {} : { aviso: AVISO_RETIRO_MANUAL }),
  });
});
