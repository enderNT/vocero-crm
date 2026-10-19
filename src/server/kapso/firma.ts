import { createHmac, timingSafeEqual } from "node:crypto";
import { listKapsoWebhookSecrets } from "@/server/whatsapp/credentials";

/**
 * 031 — Firma del reenvío de Kapso: `X-Webhook-Signature` es el HMAC-SHA256
 * del cuerpo crudo, en hex minúscula y SIN prefijo (a diferencia del
 * `sha256=` de Meta), con el secreto que Vocero generó al conectar.
 *
 * Devuelve los `phone_number_id` de las conexiones cuyo secreto firmó; vacío
 * si la firma falta, está mal formada o no coincide con ninguna.
 */
export async function verificarFirmaKapso(
  rawBody: string,
  header: string | null
): Promise<Set<string>> {
  const autorizados = new Set<string>();
  if (!header || !/^[0-9a-f]{64}$/.test(header)) return autorizados;
  const recibida = Buffer.from(header, "hex");
  for (const conexion of await listKapsoWebhookSecrets()) {
    const esperada = createHmac("sha256", conexion.secret)
      .update(rawBody)
      .digest();
    if (timingSafeEqual(recibida, esperada)) {
      autorizados.add(conexion.phoneNumberId);
    }
  }
  return autorizados;
}

/** Firma un cuerpo como lo hace Kapso (para el mock y los tests). */
export function firmarComoKapso(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
