# Contrato — API de ajustes de WhatsApp

Cambios a rutas existentes (`src/app/api/settings/whatsapp/*` y
`src/app/api/settings/webhook`). Todas siguen detrás de `withAuth`. Con la
bandera `KAPSO` apagada, el comportamiento es **idéntico al actual** y
cualquier `source: "kapso"` en un cuerpo → `404 kapso_apagado`.

## `GET /api/settings/whatsapp`

```jsonc
{
  "connection": {
    "source": "meta" | "kapso",          // nuevo
    "wabaId": "…",
    "phoneNumberId": "…",
    "displayPhoneNumber": "+52 …",
    "verifiedName": "…",
    "status": "connected" | "reconnect_required",
    "tokenLast4": "a1b2",                // token de Meta o llave de Kapso
    "kapso": {                            // nuevo; solo si source = "kapso"
      "webhookRegistered": true,          // hay kapso_webhook_id
      "webhookUrl": "https://…/api/webhooks/wa-kapso/…"  // para pegar a mano
    }
  } | null,
  "kapsoAvailable": true                  // nuevo: bandera encendida
}
```

El secreto **nunca** sale en el GET.

## `POST /api/settings/whatsapp/test`

```jsonc
// cuerpo
{ "source": "meta" | "kapso",  // nuevo, default "meta"
  "phoneNumberId": "…", "token": "…" }
```

Con `kapso`: `GET /{phone_number_id}?fields=display_phone_number,verified_name`
por el proxy con la llave. Respuestas iguales a las de hoy (`ok`,
`displayPhoneNumber`, `verifiedName` | `code`, `message`); una llave rechazada
→ `422 token_invalido` con el texto "Kapso rechazó la llave del proyecto".

## `PUT /api/settings/whatsapp`

```jsonc
// cuerpo
{ "source": "meta" | "kapso",  // nuevo, default "meta"
  "wabaId": "…", "phoneNumberId": "…", "token": "…" }
```

Con `source: "kapso"`:

1. Prueba la conexión (como `/test`). Falla → `422`/`503`, nada se guarda.
2. Genera un secreto nuevo, guarda la conexión con `source = 'kapso'`, la
   llave y el secreto cifrados. Si la conexión anterior era Meta, intenta
   quitar el override de webhook en Meta con el token viejo (best-effort, como
   el `DELETE` actual).
3. `registrarReenvio` en Kapso (contrato `transporte.md`). **No** llama a
   `registerWebhookForNumber` de Meta.
4. Responde:

```jsonc
{
  "ok": true,
  "displayPhoneNumber": "…",
  "webhook": { "ok": true }
           | { "ok": false, "code": "…", "message": "…",
               "manual": { "url": "https://…/api/webhooks/wa-kapso/…",
                           "secret": "…" } }   // ÚNICA vez que viaja el secreto
}
```

Con `source: "meta"` y una conexión anterior Kapso: borra el webhook en Kapso
(best-effort) y limpia secreto e id antes de seguir el flujo actual.

## `DELETE /api/settings/whatsapp`

Con conexión Kapso: `borrarWebhook` en Kapso (best-effort) en lugar de
`unregisterWebhookForNumber`; después `desconectarCanal`. `200 { ok: true }`
aunque Kapso falle.

## `POST /api/settings/webhook` (reintentar registro)

Con conexión Kapso: `registrarReenvio` con el secreto guardado (no lo
regenera). Si vuelve a fallar, `422` con `manual.url` pero **sin** el secreto
(ya se mostró al guardar; si se perdió, se reconecta para generar otro).

## `GET /api/settings/webhook`

Con conexión Kapso devuelve la URL de `wa-kapso`, `signatureLayer: true` y
`provider: "kapso"`; no muestra `verifyToken` (Kapso no lo usa).
