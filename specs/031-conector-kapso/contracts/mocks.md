# Contrato — Mock de Kapso (entorno de pruebas)

Vive en `src/app/api/dev/kapso-mock/` detrás de `mockGuard()` (404
incondicional en producción). Se usa con
`KAPSO_BASE_URL=<app>/api/dev/kapso-mock`. Comparte el estado del wa-mock
(`src/server/dev/wa-mock-state.ts`: bandeja de salida, plantillas, media) para
que los self-tests existentes puedan leer lo enviado con las mismas rutas
`/api/dev/wa-mock/outbox`.

## Proxy — `/{KAPSO_BASE_URL}/meta/whatsapp/v24.0/[...path]`

Mismas respuestas que `wa-mock/graph`, con estas diferencias:

| Regla | Comportamiento |
|---|---|
| Auth | Exige `X-API-Key`. Llave válida: `kapso_test_key` (constante del mock). Sin cabecera, llave inválida, **o** si llega `Authorization` → `401` con forma de Meta (`code: 190`). Así un test detecta si el adaptador mandó Bearer. |
| Versión | Solo `v24.0`; otra → `404`. |
| `GET /{media_id}` | Exige `?phone_number_id`; sin él → `400`. Devuelve `url` (lookaside falso que **siempre** responde 401) y `download_url` → `…/kapso-mock/meta/whatsapp/media_download?token=…`, `file_size` como **cadena**. |
| `GET /media_download?token=` | Bytes del media; token vencido (`?token=expired`) → `410`. Rechaza si trae `X-API-Key` o `Authorization` (prueba que no se mandan). |
| `subscribed_apps`, `webhook_configuration` | `404` (el proxy real no los tiene). |
| Camino infeliz | Llave `kapso_revoked_key` → `401`; cabecera de prueba `x-mock-fail: 429` → `429 { error: "Rate limit exceeded" }`; `x-mock-fail: 503` → `503`. |

## Plataforma — `/{KAPSO_BASE_URL}/platform/v1/whatsapp/phone_numbers/{id}/webhooks[/{webhookId}]`

`GET` lista, `POST` crea, `PATCH` actualiza, `DELETE` borra. Regla real: un solo
`kind: "meta"` por número; un segundo `POST` meta → `422`. El mock guarda url y
`secret_key` para que la inyección de entrantes firme con ellos.

## Inyección de entrantes — `POST /api/dev/kapso-mock/inbound`

Como `wa-mock/inbound`, pero entrega el payload Meta a la URL del webhook `meta`
registrado para ese número, firmado con `X-Webhook-Signature` (hex, sin
prefijo) y con `X-Idempotency-Key`. Opciones de cuerpo: `badSignature: true`,
`noSignature: true`, `duplicate: true` (entrega dos veces el mismo evento),
`echo: true` (manda `smb_message_echoes`), `media: { type }`.

Si el número no tiene webhook registrado en el mock → `409` (el test debe
conectar primero o registrar a mano).
