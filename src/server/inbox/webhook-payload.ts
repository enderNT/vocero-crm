import type { WebhookPayload } from "@/server/inbox/webhook";
import {
  processEchoesValue,
  processMessagesValue,
  type AceptarConexion,
} from "@/server/inbox/ingest";
import { processTemplateStatusValue } from "@/server/whatsapp/template-events";

/**
 * Procesa un payload con forma de Meta (`entry[].changes[]`). Lo comparten la
 * ruta de Meta y la de Kapso (031): cambian las capas de entrada, no la
 * ingesta. `aceptar` decide qué conexiones admite la ruta por la que llegó.
 */
export async function processPayload(
  payload: WebhookPayload,
  aceptar: AceptarConexion
): Promise<void> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (!change.value) continue;
      if (change.field === "messages") {
        await processMessagesValue(change.value, aceptar);
      } else if (change.field === "smb_message_echoes") {
        // 008: mensajes enviados a mano desde la app del teléfono (coexistence)
        await processEchoesValue(change.value, aceptar);
      } else if (change.field === "message_template_status_update") {
        await processTemplateStatusValue(entry.id ?? null, change.value, aceptar);
      }
      // otros fields: ignorar sin error
    }
  }
}
