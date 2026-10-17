# Data model — 031 Conector opcional Kapso

Un solo cambio de esquema: la tabla existente `meta_credentials` (la conexión
de WhatsApp, una por organización) gana una **fuente** y dos datos propios de
Kapso. Migración `drizzle/0021_whatsapp_fuente_kapso.sql`, **aditiva**, sin
backfill: toda fila existente queda `source = 'meta'` por default. Se aplica
siempre, con la bandera encendida o apagada (patrón ADR-001: unas columnas
nulas son inertes).

No se renombra la tabla: `meta_credentials` aparece en 20 migraciones, en el
doctor y en los mocks; renombrarla es ruido sin valor de comportamiento.

## `meta_credentials` (conexión de WhatsApp)

| Columna | Tipo | Nulo | Default | Nueva | Notas |
|---|---|---|---|---|---|
| `id` | text PK | no | | | |
| `organization_id` | text FK | no | | | Único (una conexión por organización). |
| `waba_id` | text | no | | | Con Kapso: el WABA real de Meta, igual que hoy. |
| `phone_number_id` | text | no | | | Único en la instancia. Con Kapso: el id real de Meta (Kapso lo usa como identificador principal). |
| `display_phone_number` | text | sí | | | |
| `verified_name` | text | sí | | | |
| `token_cipher` / `token_iv` / `token_tag` | text | no | | | **Meta**: token de usuario del sistema. **Kapso**: llave del proyecto. Mismo cifrado AES-256-GCM. |
| `status` | enum `connected` \| `reconnect_required` | no | `connected` | | Una llave rechazada por Kapso la pasa a `reconnect_required`. |
| `source` | enum `meta` \| `kapso` | no | `meta` | ✅ | Por dónde habla este número. |
| `webhook_secret_cipher` / `_iv` / `_tag` | text | sí | | ✅ | Solo Kapso: secreto con el que Kapso firma el reenvío. Lo genera Vocero. Obligatorio si `source = 'kapso'`. |
| `kapso_webhook_id` | text | sí | | ✅ | Solo Kapso: id del webhook `meta` dado de alta en Kapso, para actualizarlo o borrarlo. Nulo si el alta automática falló y se configuró a mano. |
| `created_at` / `updated_at` | timestamp | no | now | | |

### Reglas de validación

- `source = 'kapso'` ⇒ `webhook_secret_*` no nulos. Lo garantiza la capa de
  guardado (no un `CHECK` de base de datos, para que la migración siga siendo
  aditiva y re-ejecutable en instancias existentes).
- `source = 'meta'` ⇒ `webhook_secret_*` y `kapso_webhook_id` nulos. Al pasar
  de Kapso a Meta con el mismo número, el guardado los borra.
- El secreto: 32 bytes aleatorios en base64url, generado con
  `crypto.randomBytes`. Se regenera solo al reconectar, no en cada lectura.
- Hacia el navegador solo viajan: `source`, `tokenLast4`, si hay secreto
  (`webhookSecretSet: boolean`) y si hay alta automática
  (`kapsoWebhookRegistered: boolean`). El secreto completo solo se muestra
  **una vez**, en la respuesta del guardado, cuando el alta automática falla y
  hay que pegarlo a mano.

### Transiciones

```
(sin conexión) ──guardar Meta──▶ meta/connected
(sin conexión) ──guardar Kapso──▶ kapso/connected
meta/connected ──guardar Kapso (mismo u otro número)──▶ kapso/connected   (historial intacto)
kapso/connected ──guardar Meta──▶ meta/connected                          (borra secreto e id; retira el webhook en Kapso, best-effort)
*/connected ──credencial rechazada (401 / código 190)──▶ */reconnect_required
*/reconnect_required ──guardar de nuevo──▶ */connected
* ──desconectar──▶ (sin conexión)                                          (Kapso: borra el webhook en Kapso, best-effort)
```

Un error transitorio (5xx, 429, red) nunca cambia `status`.

## Tipo `Credentials` (servidor)

`src/server/whatsapp/credentials.ts` gana dos campos. Todo el que hoy recibe
`Credentials` sigue funcionando; solo el transporte los mira.

```ts
export type Credentials = {
  id: string;
  organizationId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: "connected" | "reconnect_required";
  token: string;                       // token de Meta o llave de Kapso
  source: "meta" | "kapso";            // nuevo
  webhookSecret: string | null;        // nuevo, descifrado; solo Kapso
  kapsoWebhookId: string | null;       // nuevo
};
```

Nueva consulta: `listKapsoWebhookSecrets(): Promise<{ id; phoneNumberId; secret }[]>`
para la verificación de firma (todas las conexiones Kapso de la instancia; en la
práctica una).

## Sin otras entidades

Contactos, conversaciones, mensajes, plantillas y adjuntos no cambian: el
mensaje no sabe por qué transporte salió o entró (FR-002). La idempotencia sigue
siendo `wa_message_id` UNIQUE.
