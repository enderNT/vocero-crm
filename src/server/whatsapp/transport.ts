import { graphRequest, MetaApiError } from "@/lib/meta/client";
import type { Credentials } from "@/server/whatsapp/credentials";
import {
  downloadGraphMedia,
  uploadGraphMedia,
} from "@/server/whatsapp/graph-media";
import { kapsoEnabled } from "@/server/kapso/flag";
import { kapsoTransport } from "@/server/kapso/transport";

/**
 * 031 — Frontera entre el dominio y "con quién se habla" en WhatsApp.
 *
 * La bandeja, el agente, las plantillas, el cerebro externo y el doctor piden
 * el transporte de la conexión y no saben si del otro lado está la Graph API
 * de Meta o el proxy de Kapso (FR-002). Las dos implementaciones lanzan los
 * mismos errores (`MetaApiError`, y `MediaFetchError` en la descarga), así que
 * la traducción a mensajes para el operador no cambia.
 *
 * Contrato: specs/031-conector-kapso/contracts/transporte.md
 */
export interface WhatsAppTransport {
  /** GET/POST/DELETE con forma de Graph sobre `path` relativo a la versión. */
  request<T>(
    path: string,
    opts?: { method?: "GET" | "POST" | "DELETE"; body?: unknown }
  ): Promise<T>;

  /** POST /{phone_number_id}/media (multipart). Devuelve el media id. */
  uploadMedia(file: {
    data: Buffer | Uint8Array;
    mimeType: string;
    fileName?: string;
  }): Promise<string>;

  /** Metadata + bytes de un adjunto entrante. */
  downloadMedia(
    waMediaId: string,
    maxBytes: number
  ): Promise<{ data: Buffer; mimeType: string | null; fileSize: number }>;
}

type TransportCredentials = Pick<
  Credentials,
  "phoneNumberId" | "token" | "source"
>;

/** Modo directo: la Graph API de Meta del entorno, con `Bearer`. */
function metaTransport(creds: TransportCredentials): WhatsAppTransport {
  return {
    request: (path, opts) =>
      graphRequest(path, { ...opts, token: creds.token }),
    uploadMedia: (file) => uploadGraphMedia(creds, file),
    downloadMedia: (waMediaId, maxBytes) =>
      downloadGraphMedia(creds.token, waMediaId, maxBytes),
  };
}

export const KAPSO_APAGADO_MENSAJE =
  "El conector Kapso está apagado en esta instancia";

/**
 * El transporte de una conexión. Con `source = 'kapso'` y la bandera apagada
 * lanza un error claro con `status: 0` — el envío lo traduce a
 * `meta_unavailable` y no marca reconexión (la llave no tiene la culpa).
 */
export function transportFor(creds: TransportCredentials): WhatsAppTransport {
  if (creds.source === "kapso") {
    if (!kapsoEnabled()) {
      throw new MetaApiError(KAPSO_APAGADO_MENSAJE, { status: 0 });
    }
    return kapsoTransport(creds);
  }
  return metaTransport(creds);
}
