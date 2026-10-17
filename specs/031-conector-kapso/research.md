# Research — 031 Conector opcional Kapso

Fase 0 de `/speckit-plan`. Fuentes revisadas el 2026-10-17:

- Documentación de Kapso: `https://docs.kapso.ai/llms.txt` y `llms-full.txt`
  (páginas *Webhooks overview*, *Rate limits*, *API reference*, *Migrate from
  360dialog*, *TypeScript SDK → Webhooks*).
- OpenAPI oficiales: `https://docs.kapso.ai/api/meta/whatsapp/openapi-whatsapp.yaml`
  (Meta Proxy API) y `https://docs.kapso.ai/api/platform/v1/openapi-platform.yaml`
  (Platform API).
- Skill `integrate-whatsapp` de `gokapso/agent-skills` (referencias de
  webhooks y API).
- Código de Vocero en `main` @ `d4e9b1a` (1.6.0).

Ninguna prueba en vivo contra Kapso todavía: lo que depende de una prueba real
queda marcado como **Por verificar en vivo** y tiene degradación definida.

---

## R1 — Autenticación y base del proxy de WhatsApp

**Decision**: el transporte Kapso llama a
`{KAPSO_BASE_URL}/meta/whatsapp/v24.0/{path}` con la cabecera
`X-API-Key: <llave del proyecto>`. `KAPSO_BASE_URL` por defecto
`https://api.kapso.ai` (sobrescribible para el mock, igual que
`ZERNIO_BASE_URL`). La versión `v24.0` es una constante del adaptador Kapso, no
`META_GRAPH_API_VERSION`.

**Rationale**: el OpenAPI declara `servers: https://api.kapso.ai/meta/whatsapp/v24.0`
y `X-API-Key` como método recomendado. Las formas de petición y respuesta son
las de Graph, así que el cuerpo de cada llamada de Vocero no cambia. La versión
de Vocero (`v25.0`) no está documentada en Kapso; fijar la de Kapso evita
depender de algo no garantizado.

**Alternatives considered**:
- *Solo cambiar `META_GRAPH_BASE_URL`*: descartado. Es global, la comparten
  Messenger (`src/server/messenger/send.ts`) y la copia de creativos de anuncios
  (`src/server/attribution/creativo.ts`); además rompe el modo directo en la
  misma instancia.
- *`Authorization: Bearer <llave>`*: el OpenAPI dice que Bearer se acepta "por
  compatibilidad" pero no aclara si con la llave del proyecto. No se depende de
  eso.

## R2 — Formato de errores del proxy

**Decision**: reutilizar el parseo de `MetaApiError` tal cual.

**Rationale**: los errores 4xx del proxy tienen la forma de Meta
(`{ error: { message, type, code, error_subcode, fbtrace_id } }`), así que
`isAuthError` (401 o código 190) y la traducción a `SendError` siguen sirviendo.
Excepción: el **429** de límite de uso responde `{ "error": "Rate limit
exceeded", "message": … }` (cadena, no objeto) con `Retry-After`. El parseo
actual cae a "respondió 429", que no es error de autenticación; basta con que el
adaptador lo trate como transitorio (`meta_unavailable`) y no marque la conexión
como "requiere reconexión".

**Alternatives considered**: un tipo de error propio de Kapso. Descartado: la
bandeja ya habla el vocabulario de `SendError`; uno nuevo obligaría a tocar UI.

## R3 — Límites de uso

**Decision**: no se agrega cola ni limitador en v1; el 429 se reporta como
fallo transitorio reintentable y se documenta el límite por plan en la guía.

**Rationale**: Kapso limita por llave y por minuto fijo (Free 100, Pro 1000,
Platform 2000, Enterprise 4000). Una instancia = un negocio = un número; el
tráfico normal de una bandeja está muy por debajo de 100/min salvo envíos
masivos, que Vocero no hace. Un limitador sería complejidad sin caso real.

**Alternatives considered**: leer `X-RateLimit-Remaining` y frenar. Queda como
mejora futura si aparece el caso.

## R4 — Recepción: tipo de webhook

**Decision**: usar webhooks de número tipo **`meta`** (reenvío crudo del payload
de Meta), nunca los eventos propios de Kapso.

**Rationale**: el payload es el mismo `entry[].changes[].value` que hoy ingesta
`src/server/inbox/ingest.ts`, así que no hace falta traductor. El SDK de Kapso
documenta que en este reenvío vienen los **ecos de coexistencia**
(`smb_message_echoes`, marcados por su normalizador como
`kapso.source = "smb_message_echo"`), así que la función 008 sigue viva.

**Alternatives considered**: eventos Kapso (`whatsapp.message.received`, v2)
con `media_url` listo. Descartado: obliga a un traductor completo y a mantenerlo
cuando Kapso cambie su formato.

## R5 — Recepción: firma

**Decision**: verificar `X-Webhook-Signature` = HMAC-SHA256 **hex, sin prefijo
`sha256=`**, sobre el cuerpo crudo, con el `secret_key` de esa conexión. El
secreto lo genera Vocero (32 bytes aleatorios en base64url), se guarda cifrado y
es obligatorio: sin firma válida no hay efectos.

**Rationale**: así lo documenta Kapso para webhooks tipo `meta` (el secreto es
obligatorio y "no se genera por ti"). Las cabeceras que llegan son
`Content-Type`, `X-Idempotency-Key` y `X-Webhook-Signature`. No hay
`hub.challenge`: el alta del webhook no hace un GET de verificación.

**Alternatives considered**: reutilizar `META_APP_SECRET`. Descartado: es otra
firma con otro formato (`x-hub-signature-256: sha256=…`) y otro secreto.

## R6 — Recepción: ¿misma URL o una propia?

**Decision**: una ruta propia, `POST /api/webhooks/wa-kapso/[webhookToken]`, con
el mismo segmento secreto (`META_WEBHOOK_VERIFY_TOKEN`) que la de Meta. Responde
404 con la bandera apagada. Tras verificar la firma, pasa el payload a la
**misma** función de procesado que la ruta de Meta, con un filtro que solo deja
entrar eventos de los números cuyas conexiones Kapso firmaron. La ruta de Meta,
a su vez, ignora eventos de números conectados por Kapso.

**Rationale**:
- Con la bandera apagada la superficie desaparece sola (FR-001, ADR-001), sin
  condicionales dentro de la ruta de Meta.
- Cierra el hueco de "modo sin firma": hoy la ruta de Meta acepta eventos sin
  firma si no hay `META_APP_SECRET`; si también aceptara eventos de números
  Kapso, quien conozca la URL podría inyectarlos. Con el filtro, un número Kapso
  solo recibe por la ruta firmada.
- La URL no la pega una persona: la registra Vocero en Kapso (R8), así que dos
  URLs no cuestan nada en la experiencia.

**Spec impact**: FR-009 decía "por la misma URL secreta". Se ajusta en la spec a
"por una URL secreta propia del conector" (el resto del requisito no cambia).

**Alternatives considered**: misma URL con detección de formato por cabecera
(precedente Messenger/Zernio en 017). Descartado aquí porque los dos formatos
son idénticos en el cuerpo (ambos son payload de Meta): la única diferencia es
la cabecera de firma, y decidir por cabecera hace que una petición sin ninguna
firma caiga en el camino permisivo de Meta.

## R7 — Recepción: eventos de plantillas

**Decision**: tratar el cambio de estado de plantillas como **no disponible**
con Kapso. Con conexión Kapso, Vocero sincroniza plantillas
(`GET /{waba_id}/message_templates`) al abrir Configuración → Plantillas y con el
botón existente, y la pantalla avisa que el estado se actualiza al sincronizar.

**Rationale**: la guía de migración de Kapso dice explícitamente que para
`waba_template_status_changed` / `category_changed` / `quality_score_changed`
"no hay evento: consulta `GET /{waba_id}/message_templates`". El reenvío `meta`
está acotado al número, y `message_template_status_update` es un evento de la
WABA. Si en la prueba en vivo resulta que sí llega, la ingesta actual ya lo
procesa sin cambios (no hace falta código para aprovecharlo).

**Por verificar en vivo**: si llega `message_template_status_update` por el
reenvío `meta`.

**Alternatives considered**: sondeo periódico en segundo plano. Descartado en
v1: Vocero no tiene planificador y un sondeo por instancia gasta cuota de la
llave (R3) para un dato que el operador mira al enviar plantillas.

## R8 — Alta automática del webhook en Kapso

**Decision**: al guardar una conexión Kapso, Vocero:
1. lista `GET /platform/v1/whatsapp/phone_numbers/{phone_number_id}/webhooks`;
2. si ya hay uno `kind: meta` (Kapso permite **uno por número, incluso
   inactivo**), lo actualiza con `PATCH …/webhooks/{id}` (url, `secret_key`,
   `active: true`);
3. si no, lo crea con `POST …/webhooks` `{ whatsapp_webhook: { kind: "meta",
   url, secret_key, active: true } }`;
4. guarda el `id` del webhook.

Si algo falla, la conexión queda guardada y la tarjeta muestra URL y secreto
para pegarlos en el panel de Kapso, con botón "Reintentar" (mismo trato
best-effort que `registerWebhookForNumber`). Al desconectar, `DELETE
…/webhooks/{id}` best-effort.

**Rationale**: la misma llave del proyecto autentica la Platform API (OpenAPI:
`ApiKeyAuth`). Crear en vez de actualizar fallaría con 422 si el número ya tenía
un reenvío `meta` configurado a mano o por otra instancia. El `secret_key` vuelve
en la respuesta de alta; Vocero no lo necesita de vuelta porque lo generó él.

**Alternatives considered**: solo instrucciones manuales. Descartado: es la
parte más propensa a errores (el secreto) y la API lo resuelve.

## R9 — Adjuntos entrantes

**Decision**: con conexión Kapso, `GET /{media_id}?phone_number_id={id}`
(parámetro **obligatorio**) y descargar de `download_url` **sin cabeceras de
autenticación** (la llave va embebida en el token del enlace, válido 4 min). Si
la descarga responde 401/403/410 por vencimiento, se pide la metadata una vez más
y se reintenta una vez. `file_size` llega como **cadena**: se convierte a número
antes de compararlo con el límite.

**Rationale**: así lo documenta el OpenAPI (`getMediaUrl` → `download_url`,
`download_url_expires_at`). El `url` de `lookaside.fbsbx.com` que también llega
necesita el token de Meta, que con Kapso no existe.

**Alternatives considered**: `message.kapso.media_url` de los eventos Kapso.
Descartado por R4.

## R10 — Adjuntos salientes

**Decision**: misma subida multipart (`POST /{phone_number_id}/media`, campos
`messaging_product`, `type`, `file`) con la base y cabecera de Kapso.

**Rationale**: el proxy expone esa ruta con la forma de Meta. Los límites de
tamaño que documenta Kapso coinciden con los de Meta que ya aplica Vocero.

## R11 — Lo que no pasa por Kapso

**Decision**: con conexión Kapso, Vocero **no** llama a `subscribed_apps` ni a
`webhook_configuration` (el proxy no los expone). La CAPI de anuncios no cambia:
usa su propio token y su propio dataset, guardados en Ajustes → Anuncios
(`src/server/attribution/conversions.ts` solo consulta las credenciales de
WhatsApp para saber si hay conexión). Messenger e Instagram siguen con sus
propios clientes.

**Rationale**: separar el transporte por conexión de WhatsApp (R1) deja intacto
todo lo demás.

## R12 — Bandera

**Decision**: `KAPSO=on` (mismos valores "encendida" que `ATRIBUCION`/`AGENDA`),
leída de `process.env` directo en `src/server/kapso/flag.ts`. Con la bandera
apagada y una conexión Kapso guardada, el canal queda inactivo: los envíos
fallan con un error claro ("El conector Kapso está apagado en esta instancia")
y los eventos no entran (la ruta responde 404).

**Rationale**: Kapso no es un canal (no va en `CHANNELS`): es otra forma de
hablar con el mismo canal. Mismo patrón de lectura que las demás banderas para
no depender de que todo el entorno valide.

## R13 — Verificación

**Decision**: mock propio en `src/app/api/dev/kapso-mock/` detrás del mismo gate
(`mockGuard`) que reutiliza el estado del wa-mock (bandeja de salida, plantillas,
media) pero exige `X-API-Key`, rechaza Bearer, imita `media_download`, la
Platform API de webhooks (con la regla "uno `meta` por número") y firma los
eventos entrantes al estilo Kapso. Self-test nuevo `scripts/e2e-kapso.mjs` y
guion `tests/e2e/us-kapso.md`. CI: la configuración `completo` de la matriz
agrega `KAPSO: "on"`.

**Rationale**: Principio II.5 (CI apagado y encendido con mock y camino infeliz)
y Definición de Hecho reforzada.

## Pendientes de verificación en vivo (no bloquean el plan)

| # | Qué | Cómo se verifica | Si falla |
|---|-----|------------------|----------|
| V1 | Llega un texto entrante por el reenvío `meta` con la firma esperada | Número de prueba conectado en Kapso + instancia de staging | Bloqueante: revisar R5 |
| V2 | `download_url` descarga sin cabeceras | Enviar una imagen al número | Bloqueante para adjuntos |
| V3 | Llega `smb_message_echoes` | Escribir desde la app del teléfono (coexistencia) | Degradar: documentar que los ecos no llegan |
| V4 | Llega `message_template_status_update` | Crear plantilla y esperar revisión | Nada: ya está la sincronización (R7) |
| V5 | `PATCH` de un webhook `meta` existente cambia url y secreto | Conectar dos veces el mismo número | Fallback a borrar y crear |
