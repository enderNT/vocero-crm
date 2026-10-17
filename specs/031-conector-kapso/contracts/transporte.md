# Contrato — Transporte de WhatsApp (adaptador)

Frontera nueva entre el dominio y "con quién se habla". El dominio (bandeja,
agente, plantillas, cerebro externo, doctor) llama al transporte con las
`Credentials` de la conexión y **no sabe** si del otro lado está Meta o Kapso
(FR-002).

## Interfaz (`src/server/whatsapp/transport.ts`)

```ts
export interface WhatsAppTransport {
  /** GET/POST/DELETE con forma de Graph sobre `path` relativo a la versión. */
  request<T>(path: string, opts?: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
  }): Promise<T>;

  /** POST /{phone_number_id}/media (multipart). Devuelve el media id. */
  uploadMedia(file: {
    data: Buffer | Uint8Array; mimeType: string; fileName?: string;
  }): Promise<string>;

  /** Metadata + bytes de un adjunto entrante. */
  downloadMedia(waMediaId: string, maxBytes: number): Promise<{
    data: Buffer; mimeType: string | null; fileSize: number;
  }>;
}

export function transportFor(credentials: Credentials): WhatsAppTransport;
```

Errores: `MetaApiError` en todos los casos (mismo tipo para las dos
implementaciones), y `MediaFetchError` para la descarga, como hoy.

`transportFor` con `source = 'kapso'` y la bandera apagada lanza
`MetaApiError` con `status: 0` y mensaje "El conector Kapso está apagado en esta
instancia" — el envío lo traduce a `SendError("meta_unavailable", …)`, sin
marcar reconexión.

## Implementación Meta (sin cambios de comportamiento)

| Operación | Llamada |
|---|---|
| base | `{META_GRAPH_BASE_URL}/{META_GRAPH_API_VERSION}/` |
| auth | `Authorization: Bearer {token}` |
| `downloadMedia` | `GET /{media_id}` → `GET {url}` con Bearer |

Es exactamente el código actual de `graphRequest`, `uploadGraphMedia` y
`downloadGraphMedia`, movido detrás de la interfaz.

## Implementación Kapso (`src/server/kapso/transport.ts`)

| Operación | Llamada |
|---|---|
| base | `{KAPSO_BASE_URL}/meta/whatsapp/v24.0/` (`KAPSO_BASE_URL` default `https://api.kapso.ai`) |
| auth | `X-API-Key: {token}`; **nunca** `Authorization` |
| `request` | misma ruta y cuerpo que Meta |
| `uploadMedia` | `POST /{phone_number_id}/media`, mismo multipart |
| `downloadMedia` | `GET /{media_id}?phone_number_id={phone_number_id}` → `GET {download_url}` **sin cabeceras**. `file_size` llega como cadena → `Number()`. Si la descarga da 401/403/410, se pide la metadata otra vez y se reintenta **una** vez. |

### Traducción de errores

| Respuesta de Kapso | `MetaApiError` | Efecto en el envío |
|---|---|---|
| 401, o `error.code = 190` | `status 401` | `reconnect_required` (marca la conexión) |
| 429 (`{ error: "Rate limit exceeded" }`) | `status 429` | `meta_unavailable`; no marca reconexión |
| 5xx / red | `status ≥ 500` / `0` | `meta_unavailable` |
| otro 4xx con forma de Meta | `status`, `code`, `message` de Kapso | `meta_error` con el mensaje (mismas traducciones de `send-errors.ts`) |

`isAuthError` solo cambia en un punto: un 429 nunca es error de autenticación
(ya no lo era; queda cubierto por test).

## Operaciones de plataforma (`src/server/kapso/webhooks.ts`)

Solo para el alta del reenvío (research R8). Base `{KAPSO_BASE_URL}/platform/v1`,
misma cabecera `X-API-Key`.

| Función | Llamada |
|---|---|
| `listarWebhooks(phoneNumberId)` | `GET /whatsapp/phone_numbers/{id}/webhooks` |
| `crearWebhookMeta(phoneNumberId, url, secret)` | `POST /whatsapp/phone_numbers/{id}/webhooks` `{ whatsapp_webhook: { kind: "meta", url, secret_key, active: true } }` → `data.id` |
| `actualizarWebhook(phoneNumberId, webhookId, url, secret)` | `PATCH /whatsapp/phone_numbers/{id}/webhooks/{webhookId}` `{ whatsapp_webhook: { url, secret_key, active: true } }` |
| `borrarWebhook(phoneNumberId, webhookId)` | `DELETE /whatsapp/phone_numbers/{id}/webhooks/{webhookId}` |

`registrarReenvio(credentials)` orquesta: listar → si hay `kind: "meta"`,
actualizar; si no, crear. Devuelve `{ ok: true, webhookId }` o
`{ ok: false, code, message }`. Nunca lanza (best-effort, igual que
`registerWebhookForNumber`).

## Qué NO pasa por el transporte

- Messenger (`src/server/messenger/send.ts`) y la copia de creativos
  (`src/server/attribution/creativo.ts`): siguen con `graphRequest` + env de
  Meta.
- CAPI (`src/lib/meta/capi.ts`): usa su propio token y dataset.
- Registro de webhook en Meta (`connect.ts`): solo se llama con
  `source = 'meta'`.
