import { getEnv } from "@/lib/env";
import {
  graphRequest,
  MetaApiError,
  parseGraphError,
  type GraphEndpoint,
} from "@/lib/meta/client";

/**
 * 008 — Media con la Graph API de Meta: metadata, bytes y subida multipart.
 * El transporte de WhatsApp (031, `transport.ts`) envuelve estas funciones
 * para el modo directo, y el de Kapso reutiliza las piezas comunes
 * (`postMultipart`, `fetchMediaBytes`). El token JAMÁS sale del servidor.
 */

export type GraphMediaMeta = {
  url?: string;
  mime_type?: string;
  file_size?: number | string;
};

export class MediaFetchError extends Error {
  /** true si Meta ya no tiene el archivo (expirado/borrado) — no reintentar. */
  gone: boolean;
  constructor(message: string, gone = false) {
    super(message);
    this.name = "MediaFetchError";
    this.gone = gone;
  }
}

/** Pide la metadata de un media; un 404 significa que ya no existe. */
export async function fetchMediaMeta(
  path: string,
  opts: { token: string; endpoint?: GraphEndpoint }
): Promise<GraphMediaMeta> {
  try {
    return await graphRequest<GraphMediaMeta>(path, opts);
  } catch (err) {
    const gone = err instanceof MetaApiError && err.status === 404;
    throw new MediaFetchError("Meta no entregó la metadata del adjunto", gone);
  }
}

/** Valida el tamaño anunciado (Meta lo manda número; Kapso, cadena). */
export function assertDeclaredSize(meta: GraphMediaMeta, maxBytes: number): void {
  const declared = Number(meta.file_size ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }
}

/**
 * Descarga los bytes de una URL de media. `status` del fallo queda en el
 * error para que quien llama decida si reintenta con un enlace nuevo.
 */
export async function fetchMediaBytes(
  url: string,
  headers: Record<string, string>,
  meta: GraphMediaMeta,
  maxBytes: number
): Promise<{ data: Buffer; mimeType: string | null; fileSize: number }> {
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new MediaFetchError("No se pudo descargar el adjunto");
  }
  if (!res.ok) {
    const err = new MediaFetchError(
      `La descarga devolvió ${res.status}`,
      res.status === 404 || res.status === 410
    );
    (err as MediaFetchError & { status?: number }).status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new MediaFetchError("El adjunto excede el límite de tamaño", true);
  }
  return {
    data: buf,
    mimeType: meta.mime_type ?? res.headers.get("content-type"),
    fileSize: buf.byteLength,
  };
}

/**
 * Descarga un media de Graph: GET {mediaId} → url efímera → GET con Bearer.
 */
export async function downloadGraphMedia(
  token: string,
  waMediaId: string,
  maxBytes: number
): Promise<{ data: Buffer; mimeType: string | null; fileSize: number }> {
  const meta = await fetchMediaMeta(waMediaId, { token });
  if (!meta.url) throw new MediaFetchError("Meta no entregó URL del adjunto");
  assertDeclaredSize(meta, maxBytes);
  return fetchMediaBytes(
    meta.url,
    { Authorization: `Bearer ${token}` },
    meta,
    maxBytes
  );
}

/** Formulario multipart de `POST /{phone_number_id}/media`. */
export function mediaUploadForm(file: {
  data: Buffer | Uint8Array;
  mimeType: string;
  fileName?: string;
}): FormData {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", file.mimeType);
  const bytes = new Uint8Array(file.data);
  form.set(
    "file",
    new Blob([bytes], { type: file.mimeType }),
    file.fileName ?? "adjunto"
  );
  return form;
}

/**
 * POST multipart con forma de Graph. Errores → `MetaApiError` con las mismas
 * reglas que `graphRequest`. Devuelve el `id` de la respuesta.
 */
export async function postMultipart(
  url: string,
  headers: Record<string, string>,
  form: FormData
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: form });
  } catch (cause) {
    throw new MetaApiError("No se pudo contactar la API de Meta", {
      status: 0,
      details: cause,
    });
  }
  const text = await res.text();
  if (!res.ok) throw parseGraphError(res, text);
  let id: string | undefined;
  try {
    id = (JSON.parse(text) as { id?: string })?.id;
  } catch {}
  if (!id) {
    throw new MetaApiError("Meta no devolvió ID del media subido", {
      status: res.status,
    });
  }
  return id;
}

/**
 * Sube un archivo a Graph (`POST /{phone_number_id}/media`, multipart) y
 * devuelve el media id para usar en /messages. Errores → MetaApiError (la
 * capa de envío los traduce con las mismas reglas que el texto).
 */
export async function uploadGraphMedia(
  credentials: { phoneNumberId: string; token: string },
  file: { data: Buffer | Uint8Array; mimeType: string; fileName?: string }
): Promise<string> {
  const env = getEnv();
  const url = `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_API_VERSION}/${credentials.phoneNumberId}/media`;
  return postMultipart(
    url,
    { Authorization: `Bearer ${credentials.token}` },
    mediaUploadForm(file)
  );
}
