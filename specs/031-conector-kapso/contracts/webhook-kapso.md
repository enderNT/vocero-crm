# Contrato — Webhook de WhatsApp vía Kapso

Ruta pública nueva. Complementa a `specs/001-vocero-core/contracts/webhook.md`
(ruta de Meta), que solo cambia en el punto 5 de abajo.

## `POST /api/webhooks/wa-kapso/{webhookToken}`

Recibe el reenvío **tipo `meta`** que Kapso hace de los eventos de un número.

### Capas, en orden

1. **Bandera**: con `KAPSO` apagada → `404`, cuerpo vacío, sin leer el cuerpo.
2. **Segmento secreto**: `webhookToken` ≠ `META_WEBHOOK_VERIFY_TOKEN` → `404`.
3. **Firma**: cabecera `X-Webhook-Signature` = HMAC-SHA256 en **hex
   minúscula, sin prefijo**, del cuerpo **crudo**, con el `webhook_secret` de
   alguna conexión `source = 'kapso'`. Comparación en tiempo constante, tras
   comprobar que son 64 caracteres hex.
   - Sin cabecera, formato inválido o ningún secreto coincide → `401`, sin
     efectos.
   - Sin ninguna conexión Kapso en la instancia → `401`.
   - El resultado es el conjunto de `phone_number_id` **autorizados**: los de
     las conexiones cuyo secreto coincidió.
4. **Parseo**: cuerpo no-JSON → `200 { received: true }` sin efectos (como la
   ruta de Meta, para que Kapso no reintente en bucle).
5. **Respuesta**: `200 { received: true }` inmediata; el procesado va en
   `after()` (Kapso exige 200 en < 10 s).

### Procesado

El mismo `processPayload` que la ruta de Meta, con un filtro de origen:

| `change.field` | Acción | Filtro |
|---|---|---|
| `messages` | `processMessagesValue` (entrantes + estados) | `metadata.phone_number_id` ∈ autorizados **y** su conexión es `source = 'kapso'` |
| `smb_message_echoes` | `processEchoesValue` | igual |
| `message_template_status_update` | `processTemplateStatusValue` | la WABA (`entry.id`) pertenece a una conexión autorizada |
| otro | ignorar | |

Un evento de un número no autorizado se descarta y se registra con el
`phone_number_id` (nunca el cuerpo).

### Idempotencia

Por `wa_message_id` UNIQUE, como hoy. `X-Idempotency-Key` no se usa para
deduplicar (Kapso pide tratarla como opaca); se puede registrar para
diagnóstico.

### Sin GET

Kapso no hace `hub.challenge`. `GET` → `405`.

## Cambio en la ruta de Meta — `POST /api/webhooks/wa/{webhookToken}`

Punto 5: `processPayload` recibe el filtro inverso. Los eventos cuyo
`phone_number_id` (o WABA, para plantillas) pertenece a una conexión
`source = 'kapso'` se **descartan**, aunque la petición traiga firma de Meta
válida o no haya `META_APP_SECRET`. Un número Kapso solo recibe por su ruta
firmada.
