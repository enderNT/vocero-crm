# Implementation Plan: Conector opcional Kapso para el canal WhatsApp

**Branch**: `031-conector-kapso` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/031-conector-kapso/spec.md`

## Summary

Que una conexión de WhatsApp pueda hablar con Meta **a través de Kapso**, por
conexión y detrás de la bandera `KAPSO`. Tres piezas:

1. **Transporte** (`transportFor(credentials)`): una interfaz única para las
   llamadas a la API de WhatsApp, subir y bajar adjuntos. La implementación de
   Meta es el código actual movido detrás de la interfaz; la de Kapso cambia
   base (`{KAPSO_BASE_URL}/meta/whatsapp/v24.0`), cabecera (`X-API-Key`) y la
   descarga de adjuntos (`download_url`). Todo lo demás (bandeja, agente,
   plantillas, cerebro externo) solo cambia de `graphRequest(…, {token})` a
   `transportFor(creds).request(…)`.
2. **Entrada**: ruta propia `/api/webhooks/wa-kapso/[token]` que verifica la
   firma de Kapso y reutiliza la ingesta de Meta tal cual, porque Kapso
   reenvía el payload de Meta sin cambios (research R4–R6). La ruta de Meta
   ignora los números conectados por Kapso.
3. **Conexión**: la conexión gana `source` y un secreto cifrado; al guardar,
   Vocero da de alta (o actualiza) el reenvío `meta` en Kapso por su Platform
   API; si falla, muestra URL y secreto para hacerlo a mano.

Sin dependencias nuevas. Una migración aditiva.

## Technical Context

**Language/Version**: TypeScript estricto (`strict` + `noUncheckedIndexedAccess`) sobre Node 22.

**Primary Dependencies**: las del repo — Next.js 15 (App Router), React 19, Drizzle ORM 0.38, Zod 3, Better Auth. Ninguna nueva; **no** se usa el SDK `@kapso/whatsapp-cloud-api` (el núcleo habla HTTP propio, Principio II.2: el dominio no conoce al proveedor, y un SDK de terceros dentro del adaptador sería otra dependencia de runtime para cuatro llamadas).

**Storage**: PostgreSQL. Migración `0021_whatsapp_fuente_kapso` sobre `meta_credentials` (ver [data-model.md](data-model.md)).

**Testing**: Vitest (unitarios: firma, transporte, traducción de errores, guardado) + arnés E2E `scripts/e2e-kapso.mjs` contra el mock (`src/app/api/dev/kapso-mock/`) + guion `tests/e2e/us-kapso.md`.

**Target Platform**: contenedor Docker (Coolify o compose + Caddy), una instancia por negocio.

**Project Type**: monolito web (Next.js con rutas API).

**Performance Goals**: el webhook responde 200 en < 10 s (exigencia de Kapso; hoy responde en milisegundos y procesa en `after()`). La verificación de firma suma un HMAC por conexión Kapso (en la práctica, una).

**Constraints**: límite de uso de Kapso por llave (Free 100/min) → 429 tratado como transitorio (research R3). Enlaces de descarga válidos 4 min → descarga inmediata en la ingesta, un reintento con enlace nuevo (R9).

**Scale/Scope**: un número por instancia. ~15 archivos tocados, ~8 nuevos (ver estructura).

Sin `NEEDS CLARIFICATION`: todo quedó resuelto en [research.md](research.md); lo que solo se puede confirmar con un número real está listado allí como V1–V5, con degradación definida.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Cómo lo cumple | Estado |
|---|---|---|
| **I. Seguridad de datos** | Llave de Kapso en las columnas cifradas existentes (AES-256-GCM); secreto del webhook en tres columnas cifradas nuevas. Al navegador: `tokenLast4` y booleanos; el secreto viaja **una** sola vez, en la respuesta del guardado, y solo si el alta automática falló. Nada en logs (los logs del webhook registran `phone_number_id`, nunca cuerpo ni firma). | ✅ |
| **II. Soberanía — conector opcional** | (1) Apagado por defecto, `KAPSO=on`; apagado: sin UI, ruta 404, `source:"kapso"` → 404. (2) Adaptador dedicado `src/server/kapso/` detrás de `WhatsAppTransport`; el dominio no importa nada de Kapso. (3) La instancia sigue completa con modo directo/agencia; fallos de Kapso → `meta_unavailable` reintentable, nunca bloquean la ingesta ni pierden el mensaje. (4) Llave del propio negocio, cifrada; sin llave central. (5) CI: la configuración `completo` agrega `KAPSO: "on"`; mock con camino infeliz (llave revocada, 429, 503, enlace vencido, firma inválida). | ✅ |
| **III. Multi-tenancy** | La conexión sigue siendo por `organization_id`; la verificación de firma devuelve los `phone_number_id` autorizados y la ingesta enruta por ellos como hoy. Las consultas nuevas pasan por `scoped()` salvo `listKapsoWebhookSecrets` (global por diseño, como `getCredentialsByPhoneNumberId`: el webhook todavía no sabe la organización). | ✅ |
| **IV. Idempotencia** | `wa_message_id` UNIQUE, sin cambios. El arnés reenvía el mismo evento dos veces. Registrar el webhook en Kapso es idempotente (listar → actualizar o crear). | ✅ |
| **V. Calidad verificable** | Gates + `e2e-kapso.mjs` verde con la bandera encendida; los E2E existentes verdes con la bandera apagada y encendida. La prueba en vivo con número real queda como "pendiente de verificación humana" si no hay número (SC-007). | ✅ |
| **VI. Specs antes de código** | spec + este plan + tasks antes de tocar `src/`. | ✅ |
| **Sandbox del Laboratorio** | La aserción `isTest` de `send.ts` queda **antes** de elegir transporte; test unitario y paso del arnés. | ✅ |
| **Módulos opcionales (ADR-001)** | Código en `main`, migración siempre aplicada, bandera de despliegue, superficie en 404. | ✅ |

Sin violaciones: **Complexity Tracking** no aplica.

**Re-evaluación post-diseño**: igual. El único ajuste de diseño respecto a la
spec (ruta de webhook propia, R6) **refuerza** II.1 y I: la superficie
desaparece con la bandera y un número Kapso no puede recibir eventos sin firma.

## Project Structure

### Documentation (this feature)

```text
specs/031-conector-kapso/
├── spec.md
├── plan.md              # este archivo
├── research.md          # fase 0: R1–R13 + pendientes en vivo V1–V5
├── data-model.md        # fase 1: meta_credentials + Credentials
├── quickstart.md        # fase 1: recorrido manual y en vivo
├── contracts/
│   ├── webhook-kapso.md # ruta de entrada + cambio en la de Meta
│   ├── transporte.md    # interfaz WhatsAppTransport, Meta y Kapso, plataforma
│   ├── ajustes-api.md   # /api/settings/whatsapp*, /api/settings/webhook
│   └── mocks.md         # kapso-mock
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks (no lo crea este comando)
```

### Source Code

```text
# Datos
src/lib/db/schema.ts                                  meta_credentials: source, webhook_secret_*, kapso_webhook_id
drizzle/0021_whatsapp_fuente_kapso.sql                migración aditiva (+ snapshot y journal)
src/lib/env.ts                                        KAPSO (bandera), KAPSO_BASE_URL (opcional, url)
.env.example                                          las dos, con guía inline

# Conector (nuevo)
src/server/kapso/flag.ts                              kapsoEnabled() — process.env, mismos valores "on" que ATRIBUCION
src/server/kapso/transport.ts                         implementación Kapso de WhatsAppTransport
src/server/kapso/webhooks.ts                          Platform API: listar/crear/actualizar/borrar; registrarReenvio()
src/server/kapso/firma.ts                             verificación X-Webhook-Signature (hex, sin prefijo, tiempo constante)

# Transporte de WhatsApp
src/server/whatsapp/transport.ts                      interfaz + transportFor(creds) + implementación Meta
src/lib/meta/client.ts                                graphRequest acepta { baseUrl, version, headers } opcionales (sigue siendo la única que parsea errores)
src/server/whatsapp/media.ts                          upload/download pasan a ser la implementación Meta; ensureAssetAvailable usa transportFor
src/server/whatsapp/credentials.ts                    Credentials.source/webhookSecret/kapsoWebhookId; saveCredentials por fuente; listKapsoWebhookSecrets()
src/server/whatsapp/connect.ts                        testConnection(source, phoneNumberId, token)

# Llamadores (cambio mecánico a transportFor)
src/server/inbox/send.ts                              callGraphSend, subida de adjuntos; isTest antes del transporte
src/server/whatsapp/templates.ts                      crear, sincronizar, enviar
src/app/api/bot/typing/route.ts                       marcar leído + escribiendo
src/app/api/bot/media/[mediaId]/route.ts              descarga para cerebro externo
src/server/doctor/checks.ts                           prueba del token según fuente

# Entrada
src/app/api/webhooks/wa-kapso/[webhookToken]/route.ts nueva
src/app/api/webhooks/wa/[webhookToken]/route.ts       filtro: ignora números Kapso
src/server/inbox/ingest.ts                            processMessagesValue/processEchoesValue aceptan filtro de conexión
src/server/whatsapp/template-events.ts                ídem para plantillas
src/server/whatsapp/webhook-url.ts                    WebhookChannel += "wa-kapso"

# Ajustes
src/app/api/settings/whatsapp/route.ts                GET/PUT/DELETE por fuente
src/app/api/settings/whatsapp/test/route.ts           source
src/app/api/settings/webhook/route.ts                 GET/POST por fuente
src/components/settings/whatsapp-wizard.tsx           tercera opción "Kapso" (solo con kapsoAvailable); tarjeta de webhook Kapso
src/components/settings/templates-client.tsx          aviso "con Kapso el estado se actualiza al sincronizar" + sync al abrir

# Mock y pruebas
src/app/api/dev/kapso-mock/meta/whatsapp/[...path]/route.ts
src/app/api/dev/kapso-mock/platform/v1/[...path]/route.ts
src/app/api/dev/kapso-mock/inbound/route.ts
src/server/dev/kapso-mock-state.ts                    webhooks registrados; reutiliza wa-mock-state
tests/unit/kapso-firma.test.ts
tests/unit/kapso-transport.test.ts
tests/unit/whatsapp-credentials-fuente.test.ts
scripts/e2e-kapso.mjs
tests/e2e/us-kapso.md
.github/workflows/ci.yml                              matriz "completo": KAPSO: "on"

# Docs
docs/kapso.md                                         guía para agencias: cuándo usarlo, cómo conectar, límites, qué no hace
AGENTS.md, CLAUDE.md                                  fila en el mapa del código
specs/README.md, CHANGELOG.md
```

**Structure Decision**: monolito existente. El conector vive en
`src/server/kapso/` (como `src/server/zernio/`); la única pieza nueva en el
dominio es la interfaz `WhatsAppTransport` en `src/server/whatsapp/`, cuya
implementación Meta es el código de hoy.

## Diseño por pieza

### 1. Transporte

- `graphRequest(path, { method, token, body, endpoint? })`: si viene
  `endpoint: { baseUrl, version, headers }`, se usan en vez de env + Bearer.
  Sigue siendo el único sitio que parsea errores a `MetaApiError` (las dos
  implementaciones comparten el parseo).
- `transportFor(creds)`:
  - `source === "meta"` → `{ request: (p, o) => graphRequest(p, { ...o, token }),
    uploadMedia: (f) => uploadGraphMedia(creds, f), downloadMedia: … }`.
  - `source === "kapso"` y `kapsoEnabled()` → `kapsoTransport(creds)`.
  - `source === "kapso"` y bandera apagada → transporte que lanza
    `MetaApiError(status 0, "El conector Kapso está apagado en esta instancia")`.
- `uploadGraphMedia` comparte el armado multipart con Kapso vía un helper
  `postMultipart(url, headers, form)`.
- Un test de arquitectura (vitest, búsqueda en el árbol) falla si algún archivo
  de `src/` fuera de `src/server/kapso/` y `src/lib/env.ts` contiene
  `api.kapso.ai`, o si algo dentro de `src/server/inbox/`, `src/server/ai/` o
  `src/server/whatsapp/` (salvo `transport.ts`) importa de `@/server/kapso`.

### 2. Entrada

- `verificarFirmaKapso(rawBody, header)` → `Set<phoneNumberId>` de las
  conexiones cuyo secreto coincide (vacío = 401).
- `processPayload(payload, aceptar: (creds) => boolean)`. Ruta Meta:
  `aceptar = c => c.source === "meta"`. Ruta Kapso:
  `aceptar = c => c.source === "kapso" && autorizados.has(c.phoneNumberId)`.
  `processMessagesValue`, `processEchoesValue` y `applyTemplateStatusEvent`
  reciben `aceptar` y descartan (con `console.warn` del id) si no pasa.
  Default `() => true` para no tocar los mocks existentes que llaman directo.
- La descarga de adjuntos entrantes ya ocurre en `media.ts`
  (`ensureAssetAvailable`, con las credenciales de la organización) → pasa a
  `transportFor(creds).downloadMedia` sin más cambios.

### 3. Conexión y ajustes

- `saveCredentials({ …, source, webhookSecret?, kapsoWebhookId? })`: con
  `meta` limpia las columnas Kapso; con `kapso` exige secreto.
- `PUT /api/settings/whatsapp` (contrato `ajustes-api.md`): Kapso → probar,
  generar secreto, guardar, `registrarReenvio`, guardar `kapso_webhook_id`.
  Cambio de fuente: retirar lo de la fuente vieja (best-effort) antes de
  guardar.
- Wizard: la opción "Kapso" aparece solo con `kapsoAvailable`. Campos: llave
  del proyecto, Phone Number ID, WABA ID (con ayuda: `kapso whatsapp numbers
  resolve --phone-number … --output json` los da). Tras guardar: "Registrado en
  Kapso" o tarjeta manual con URL + secreto y botón "Copiar".

### 4. Plantillas

Con `source === "kapso"`: la pantalla de plantillas llama a `syncTemplates` al
abrirse (como mucho una vez por minuto por organización, en memoria) y muestra
el aviso de R7. El webhook de estado se sigue procesando si llega (V4).

### 5. Doctor

`pnpm doctor` prueba la conexión con `transportFor(creds).request(phoneNumberId
?fields=…)`; con Kapso, además comprueba que `KAPSO=on` y que hay secreto.

## Orden sugerido (para `/speckit-tasks`)

1. Migración + `Credentials` + bandera + env (sin comportamiento visible).
2. Interfaz de transporte con implementación Meta y llamadores migrados —
   **refactor puro**: gates y E2E existentes verdes antes de seguir.
3. Mock de Kapso + transporte Kapso + tests unitarios.
4. Entrada: firma, ruta `wa-kapso`, filtro en la ruta de Meta.
5. Ajustes: API + alta del reenvío + wizard.
6. Plantillas y doctor.
7. `e2e-kapso.mjs` + guion + CI + docs.
8. Prueba en vivo (V1–V5) y anotación en `research.md`.

El paso 2 es el de más riesgo (toca todos los envíos) y no depende de Kapso: se
puede revisar y fusionar solo.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El refactor del transporte rompe un envío existente | Paso 2 aislado, con la batería E2E actual como red. |
| Kapso cambia la versión del proxy (`v24.0`) | Constante en un solo sitio del adaptador; el mock rechaza otras versiones para que un cambio se note. |
| El reenvío `meta` no trae algo que hoy se usa (V3/V4) | Degradación definida (R7) y anotada tras la prueba en vivo. |
| Secreto perdido tras un alta manual | Reconectar genera otro; el `POST /api/settings/webhook` reintenta con el guardado. |
| Límite de 100/min en plan Free | 429 transitorio; documentado en `docs/kapso.md`. |

## Complexity Tracking

No aplica: el Constitution Check no tiene violaciones.

## Agent context

`CLAUDE.md` no tiene marcadores `<!-- SPECKIT START -->`/`<!-- SPECKIT END -->`,
así que no se actualiza automáticamente; la fila del mapa del código se agrega
en la tarea de docs (paso 7).
