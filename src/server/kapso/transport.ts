import { graphRequest, type GraphEndpoint } from "@/lib/meta/client";
import { getEnv } from "@/lib/env";
import {
  assertDeclaredSize,
  fetchMediaBytes,
  fetchMediaMeta,
  MediaFetchError,
  mediaUploadForm,
  postMultipart,
  type GraphMediaMeta,
} from "@/server/whatsapp/graph-media";
import type { WhatsAppTransport } from "@/server/whatsapp/transport";

/**
 * 031 — Transporte de WhatsApp por el proxy de Kapso.
 *
 * Kapso expone la Cloud API de Meta en `{base}/meta/whatsapp/v24.0/…` con las
 * mismas rutas, cuerpos y errores; lo que cambia es la autenticación
 * (`X-API-Key` con la llave del proyecto, nunca `Authorization`) y la descarga
 * de adjuntos (un `download_url` firmado que se pide sin cabeceras).
 *
 * Contrato: specs/031-conector-kapso/contracts/transporte.md
 */

/** Versión que acepta el proxy de Kapso (no sigue a META_GRAPH_API_VERSION). */
export const KAPSO_GRAPH_VERSION = "v24.0";

type KapsoMediaMeta = GraphMediaMeta & { download_url?: string };

export function kapsoBaseUrl(): string {
  return getEnv().KAPSO_BASE_URL.replace(/\/+$/, "");
}

function endpoint(apiKey: string): GraphEndpoint {
  return {
    baseUrl: `${kapsoBaseUrl()}/meta/whatsapp`,
    version: KAPSO_GRAPH_VERSION,
    headers: { "X-API-Key": apiKey },
  };
}

export function kapsoTransport(creds: {
  phoneNumberId: string;
  token: string;
}): WhatsAppTransport {
  const ep = endpoint(creds.token);

  async function pedirMetadata(waMediaId: string): Promise<KapsoMediaMeta> {
    const path = `${waMediaId}?phone_number_id=${encodeURIComponent(creds.phoneNumberId)}`;
    return fetchMediaMeta(path, { token: creds.token, endpoint: ep });
  }

  async function descargar(meta: KapsoMediaMeta, maxBytes: number) {
    const url = meta.download_url;
    if (!url) throw new MediaFetchError("Kapso no entregó enlace de descarga");
    assertDeclaredSize(meta, maxBytes);
    // El enlace ya va firmado: sin cabeceras, para no filtrar la llave.
    return fetchMediaBytes(url, {}, meta, maxBytes);
  }

  return {
    request: (path, opts) =>
      graphRequest(path, { ...opts, token: creds.token, endpoint: ep }),

    uploadMedia: (file) =>
      postMultipart(
        `${ep.baseUrl}/${ep.version}/${creds.phoneNumberId}/media`,
        ep.headers,
        mediaUploadForm(file)
      ),

    async downloadMedia(waMediaId, maxBytes) {
      const meta = await pedirMetadata(waMediaId);
      try {
        return await descargar(meta, maxBytes);
      } catch (err) {
        // El enlace firmado vence: un enlace nuevo, una sola vez.
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403 || status === 410) {
          return descargar(await pedirMetadata(waMediaId), maxBytes);
        }
        throw err;
      }
    },
  };
}
