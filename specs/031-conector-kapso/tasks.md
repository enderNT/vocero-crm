---

description: "Task list — 031 Conector opcional Kapso para el canal WhatsApp"
---

# Tasks: Conector opcional Kapso para el canal WhatsApp

**Input**: Design documents from `specs/031-conector-kapso/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: SÍ se incluyen. La spec los exige (FR-017 mock con camino infeliz, FR-018 CI apagado/encendido + self-test E2E) y la Definición de Hecho reforzada de `CLAUDE.md` pide el self-test de comportamiento en verde.

**Organization**: Tareas agrupadas por historia de usuario de la spec. El orden sigue el "Orden sugerido" del plan: datos → refactor del transporte → transporte Kapso + mock → entrada → ajustes → plantillas/doctor → E2E/CI/docs → prueba en vivo.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede hacer en paralelo (archivos distintos, sin dependencias pendientes)
- **[Story]**: historia de la spec (US1–US5)
- Rutas relativas a la raíz del repo

## Gate técnico (después de cada fase)

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

---

## Phase 1: Setup (configuración compartida)

**Purpose**: bandera, variables de entorno y migración. Sin comportamiento visible.

- [x] T001 Agregar `KAPSO` (string opcional, bandera) y `KAPSO_BASE_URL` (url opcional) al esquema de `src/lib/env.ts`, con comentario como las demás banderas (`AGENDA`, `ATRIBUCION`)
- [x] T002 [P] Documentar `KAPSO=on` y `KAPSO_BASE_URL` en `.env.example` con guía inline (qué es Kapso, que la llave se pega en Ajustes y no aquí, default `https://api.kapso.ai`) y agregar placeholders comentados en `.env` local si existe
- [x] T003 [P] Crear `src/server/kapso/flag.ts` con `parseKapsoFlag(raw)` y `kapsoEnabled()` leyendo `process.env.KAPSO` directo, mismos valores "on" que `src/server/attribution/flag.ts` (research R12)
- [x] T004 En `src/lib/db/schema.ts`, tabla `metaCredentials`: agregar `source` (enum `meta`|`kapso`, NOT NULL, default `meta`), `webhookSecretCipher`/`webhookSecretIv`/`webhookSecretTag` (text NULL) y `kapsoWebhookId` (text NULL), según data-model.md
- [x] T005 Generar la migración con `pnpm db:generate` y renombrarla a `drizzle/0021_whatsapp_fuente_kapso.sql` (ajustando journal y snapshot en `drizzle/meta/`); verificar que es solo `ALTER TABLE … ADD COLUMN` y que se re-ejecuta sin error

**Checkpoint**: gate técnico verde; las instancias existentes migran sin cambios de comportamiento.

---

## Phase 2: Foundational (bloquea todas las historias)

**Purpose**: credenciales con fuente, interfaz de transporte (refactor puro), transporte Kapso y mock base.

**⚠️ CRITICAL**: T008–T012 son un refactor sin cambio de comportamiento: la batería E2E existente debe quedar verde antes de seguir (plan, "Riesgos").

### Credenciales

- [x] T006 En `src/server/whatsapp/credentials.ts`: extender `Credentials` con `source`, `webhookSecret` (descifrado, `null` si no hay) y `kapsoWebhookId`; `toCredentials` los lee; `saveCredentials` acepta `source`, `webhookSecret?`, `kapsoWebhookId?` (con `meta` limpia las columnas Kapso; con `kapso` exige secreto y lanza si falta); agregar `generateWebhookSecret()` (32 bytes `randomBytes` → base64url), `setKapsoWebhookId(orgId, id | null)` y `listKapsoWebhookSecrets()` → `{ id, phoneNumberId, wabaId, secret }[]` de las filas `source = 'kapso'`
- [x] T007 [P] Test unitario `tests/unit/whatsapp-credentials-fuente.test.ts`: guardar meta → columnas Kapso nulas; guardar kapso sin secreto → error; guardar kapso → secreto no queda en claro en la fila; pasar de kapso a meta limpia secreto e id

### Interfaz de transporte (refactor puro)

- [x] T008 En `src/lib/meta/client.ts`, `graphRequest` acepta `endpoint?: { baseUrl: string; version: string; headers: Record<string, string> }`; sin `endpoint` usa env + `Authorization: Bearer` exactamente como hoy. Extraer el parseo de error a `parseGraphError(res, text)` exportado para reutilizarlo en multipart
- [x] T009 Crear `src/server/whatsapp/transport.ts` con la interfaz `WhatsAppTransport` (`request`, `uploadMedia`, `downloadMedia`) y `transportFor(creds)` según contracts/transporte.md; implementación Meta envolviendo `graphRequest`, `uploadGraphMedia` y `downloadGraphMedia`; rama `kapso` lanza por ahora `MetaApiError(status 0, "El conector Kapso está apagado en esta instancia")` (se completa en T014)
- [x] T010 En `src/server/whatsapp/media.ts`: extraer el multipart a `postMultipart(url, headers, form)` reutilizando `parseGraphError`; `ensureAssetAvailable` descarga con `transportFor(creds).downloadMedia(...)`
- [x] T011 Migrar llamadores a `transportFor(creds)`: `callGraphSend` y la subida de adjuntos en `src/server/inbox/send.ts` (dejar la aserción `isTest` ANTES de obtener el transporte), creación/sincronización/envío en `src/server/whatsapp/templates.ts`, `src/app/api/bot/typing/route.ts`, `src/app/api/bot/media/[mediaId]/route.ts`
- [x] T012 En `src/server/whatsapp/connect.ts`, `testConnection` pasa a `testConnection({ source, phoneNumberId, token })` usando el transporte correspondiente (con `meta` igual que hoy); actualizar los llamadores en `src/app/api/settings/whatsapp/route.ts` y `src/app/api/settings/whatsapp/test/route.ts` pasando `source: "meta"`; y `src/server/doctor/checks.ts` para que pruebe con `transportFor(credentials)`

**Checkpoint refactor**: gate técnico + `pnpm test:e2e` y `node --env-file=.env scripts/e2e-*.mjs` existentes en verde con `KAPSO` apagada. Conviene revisar y fusionar hasta aquí por separado.

### Transporte Kapso y mock base

- [x] T013 [P] Crear `src/server/dev/kapso-mock-state.ts`: llaves válidas (`kapso_test_key`, `kapso_revoked_key`), registro de webhooks por número (regla: un `kind: "meta"` por número), tokens de descarga (`expired` → 410), reutilizando `getWaMockState()` de `src/server/dev/wa-mock-state.ts` para outbox, plantillas y media
- [x] T014 Crear `src/server/kapso/transport.ts` (implementación Kapso de `WhatsAppTransport`): base `${KAPSO_BASE_URL ?? "https://api.kapso.ai"}/meta/whatsapp` + versión constante `v24.0`, cabecera `X-API-Key` (nunca `Authorization`), `uploadMedia` multipart, `downloadMedia` con `?phone_number_id=` → `download_url` sin cabeceras, `file_size` con `Number()`, un reintento con enlace nuevo ante 401/403/410; 429 → `MetaApiError` no-auth. Conectar la rama `kapso` de `transportFor` (T009) cuando `kapsoEnabled()`
- [x] T015 Crear el mock del proxy `src/app/api/dev/kapso-mock/meta/whatsapp/[...path]/route.ts` detrás de `mockGuard()`, según contracts/mocks.md: exige `X-API-Key`, 401 si llega `Authorization`, solo `v24.0`, `GET /{media_id}` exige `phone_number_id` y devuelve `download_url` + `file_size` cadena, `GET media_download?token=` rechaza cabeceras de auth, `subscribed_apps`/`webhook_configuration` → 404, `x-mock-fail: 429|503`; para lo demás, delegar en la lógica de `src/app/api/dev/wa-mock/graph/[...path]/route.ts` (extraer un handler compartido si hace falta)
- [x] T016 [P] Test unitario `tests/unit/kapso-transport.test.ts` con `fetch` falso: usa `X-API-Key` y nunca `Authorization`; ruta `…/meta/whatsapp/v24.0/…`; descarga sin cabeceras y reintento con enlace nuevo; 401/código 190 → `isAuthError`; 429 y 503 → no auth; bandera apagada → error "conector apagado"

**Checkpoint**: gate técnico verde; el transporte Kapso funciona contra el mock en unitarios.

---

## Phase 3: User Story 1 — Conectar un número que vive en Kapso (Priority: P1) 🎯 MVP

**Goal**: el propietario conecta un número de Kapso desde Configuración → WhatsApp, lo prueba, lo guarda y queda dado de alta el reenvío (o ve cómo hacerlo a mano).

**Independent Test**: con `KAPSO=on` y el mock, conectar con `kapso_test_key` y ver número y nombre verificado; con `kapso_revoked_key` ver el error sin que se guarde nada; tras guardar, el mock tiene un webhook `kind: meta` apuntando a `/api/webhooks/wa-kapso/<token>`.

- [x] T017 [P] [US1] Crear `src/server/kapso/webhooks.ts` (Platform API, base `${KAPSO_BASE_URL}/platform/v1`, `X-API-Key`): `listarWebhooks`, `crearWebhookMeta`, `actualizarWebhook`, `borrarWebhook` y `registrarReenvio(creds, url)` que lista → PATCH si ya hay `kind: "meta"`, si no POST; devuelve `{ ok: true, webhookId } | { ok: false, code, message }` y nunca lanza (research R8)
- [x] T018 [P] [US1] Crear el mock de plataforma `src/app/api/dev/kapso-mock/platform/v1/[...path]/route.ts` (GET/POST/PATCH/DELETE de `whatsapp/phone_numbers/{id}/webhooks`, segundo POST `meta` → 422) sobre `kapso-mock-state.ts`
- [x] T019 [US1] En `src/server/whatsapp/webhook-url.ts`, agregar `"wa-kapso"` a `WebhookChannel` para que `webhookUrl("wa-kapso")` sea la única forma de armar la URL
- [x] T020 [US1] `src/app/api/settings/whatsapp/test/route.ts`: aceptar `source` (default `"meta"`); `source: "kapso"` con bandera apagada → `404 kapso_apagado`; con Kapso, mensaje de llave rechazada "Kapso rechazó la llave del proyecto" (contracts/ajustes-api.md)
- [x] T021 [US1] `src/app/api/settings/whatsapp/route.ts`: `GET` devuelve `source`, `kapsoAvailable` y el bloque `kapso` (sin secreto); `PUT` con `source: "kapso"` → probar, `generateWebhookSecret()`, guardar, `registrarReenvio(creds, webhookUrl("wa-kapso"))`, `setKapsoWebhookId`, y responder `webhook.ok` o `webhook.manual { url, secret }` (única vez que viaja el secreto); no llama a `registerWebhookForNumber`
- [x] T022 [US1] `src/app/api/settings/webhook/route.ts`: `GET` con conexión Kapso devuelve la URL `wa-kapso`, `signatureLayer: true`, `provider: "kapso"`, sin `verifyToken`; `POST` reintenta `registrarReenvio` con el secreto guardado y, si falla, devuelve `manual.url` sin secreto
- [x] T023 [US1] `src/components/settings/whatsapp-wizard.tsx`: tercera opción "Kapso" visible solo con `kapsoAvailable`; campos llave del proyecto, Phone Number ID y WABA ID con ayuda (`kapso whatsapp numbers resolve --phone-number … --output json`); "Probar conexión"; tras guardar, "Registrado en Kapso" o tarjeta manual con URL + secreto, botón Copiar y "Reintentar"; vista de conexión guardada con fuente "Kapso" y últimos 4 de la llave

**Checkpoint**: US1 se puede demostrar sola (quickstart §3).

---

## Phase 4: User Story 2 — Recibir mensajes por Kapso (Priority: P1)

**Goal**: los eventos que Kapso reenvía en formato Meta entran a la bandeja con la ingesta existente, solo con firma válida e idempotentes.

**Independent Test**: inyectar con `/api/dev/kapso-mock/inbound` un texto firmado → aparece; duplicado → uno; firma inválida o ausente → 401 sin efectos; imagen → se descarga; eco → saliente manual.

- [x] T024 [P] [US2] Crear `src/server/kapso/firma.ts`: `verificarFirmaKapso(rawBody, header)` → `Set<phoneNumberId>`; HMAC-SHA256 hex sin prefijo, valida 64 hex, `timingSafeEqual`, contra cada secreto de `listKapsoWebhookSecrets()`
- [x] T025 [P] [US2] Test unitario `tests/unit/kapso-firma.test.ts`: firma correcta; con prefijo `sha256=` → rechazada; mayúsculas/longitud incorrecta → rechazada; sin conexiones Kapso → vacío; dos conexiones, solo autoriza la que coincide
- [x] T026 [US2] Agregar un filtro `aceptar: (creds: Credentials) => boolean` (default `() => true`) a `processMessagesValue` y `processEchoesValue` en `src/server/inbox/ingest.ts`, a `processTemplateStatusValue` en `src/server/whatsapp/template-events.ts` y a `applyTemplateStatusEvent` en `src/server/whatsapp/templates.ts`; si no pasa, `console.warn` con el `phone_number_id`/WABA y descartar
- [x] T027 [US2] Crear `src/app/api/webhooks/wa-kapso/[webhookToken]/route.ts` según contracts/webhook-kapso.md: 404 con bandera apagada o token incorrecto (sin leer cuerpo), 401 sin firma válida, 200 con cuerpo no-JSON, `after()` con `processPayload` y `aceptar = c => c.source === "kapso" && autorizados.has(c.phoneNumberId)`, `GET` → 405. Extraer `processPayload` de la ruta de Meta a un módulo compartido (p. ej. `src/server/inbox/webhook-payload.ts`)
- [x] T028 [US2] Crear `src/app/api/dev/kapso-mock/inbound/route.ts`: arma el payload Meta como `wa-mock/inbound` y lo entrega a la URL del webhook `meta` registrado para el número, firmado con `X-Webhook-Signature` y `X-Idempotency-Key`; opciones `badSignature`, `noSignature`, `duplicate`, `echo`, `media`; 409 si el número no tiene webhook registrado

**Checkpoint**: US1 + US2 → un número Kapso recibe (quickstart §4).

---

## Phase 5: User Story 3 — Responder y operar por Kapso (Priority: P1)

**Goal**: todo lo que hoy sale por WhatsApp sale por Kapso con la llave del negocio, con las mismas reglas y mensajes de error.

**Independent Test**: desde la bandeja enviar texto, imagen, ubicación y plantilla fuera de ventana; el outbox del mock los registra (el mock rechaza Bearer); 429 → fallido reintentable sin reconexión; llave revocada → `reconnect_required`.

- [x] T029 [US3] Verificar y ajustar en `src/server/inbox/send.ts` la traducción de errores del transporte Kapso: 401/190 → `reconnect_required` + `markReconnectRequired`; 429, 5xx y red → `meta_unavailable` sin marcar; resto → `meta_error` pasando por `src/lib/meta/send-errors.ts` (FR-014, FR-015)
- [x] T030 [US3] En `src/components/settings/templates-client.tsx` (y su ruta de datos), con conexión Kapso: sincronizar al abrir la pantalla como mucho una vez por minuto por organización (memo en memoria en `src/server/whatsapp/templates.ts`) y mostrar el aviso "Con Kapso, el estado de las plantillas se actualiza al sincronizar" (research R7)
- [x] T031 [P] [US3] En `src/server/doctor/checks.ts`, con conexión Kapso: comprobar `KAPSO=on` y que haya secreto guardado; informar "conector Kapso" como fuente en la salida de `pnpm doctor`

**Checkpoint**: US1–US3 = MVP del conector (quickstart §5).

---

## Phase 6: User Story 4 — Convivir con los modos existentes (Priority: P2)

**Goal**: nada cambia con la bandera apagada; con la bandera encendida, Meta directo/agencia, Messenger, atribución y Laboratorio siguen igual.

**Independent Test**: E2E existentes en verde con `KAPSO` apagada y encendida; con apagada, sin menciones a Kapso y superficies en 404; evento de un número Kapso por la ruta de Meta → descartado.

- [x] T032 [US4] En `src/app/api/webhooks/wa/[webhookToken]/route.ts`, usar el `processPayload` compartido con `aceptar = c => c.source === "meta"` (contracts/webhook-kapso.md, "Cambio en la ruta de Meta")
- [x] T033 [US4] Con conexión Kapso guardada y bandera apagada: `GET /api/settings/whatsapp` devuelve la conexión con aviso "conector apagado" y el wizard lo muestra sin permitir enviar; verificar que `transportFor` falla claro (edge case de la spec) en `src/components/settings/whatsapp-wizard.tsx` y `src/app/api/settings/whatsapp/route.ts`
- [x] T034 [P] [US4] Test unitario en `tests/unit/kapso-transport.test.ts` (o archivo nuevo `tests/unit/kapso-convivencia.test.ts`): una conversación `isTest` con conexión Kapso lanza antes de tocar el transporte; `transportFor` con `source: "meta"` nunca usa `KAPSO_BASE_URL`
- [x] T035 [P] [US4] Test de arquitectura `tests/unit/kapso-frontera.test.ts`: falla si algún archivo de `src/` fuera de `src/server/kapso/` y `src/lib/env.ts` contiene `api.kapso.ai`, o si algo en `src/server/inbox/`, `src/server/ai/` o `src/server/whatsapp/` (salvo `transport.ts`) importa de `@/server/kapso` (plan, diseño §1)
- [x] T036 [US4] En `.github/workflows/ci.yml`, agregar `kapso: ""` a la configuración `default` y `kapso: "on"` a `completo`, y exportar `KAPSO: ${{ matrix.config.kapso }}`

**Checkpoint**: Principio II.5 cubierto (CI apagado y encendido).

---

## Phase 7: User Story 5 — Cambiar de fuente o desconectar (Priority: P3)

**Goal**: pasar de Kapso a Meta (o al revés) o desconectar sin tocar la base ni perder historial, retirando lo que se dio de alta del otro lado.

**Independent Test**: conectar por Kapso, cambiar a modo directo con el mismo número → historial intacto, webhook borrado en el mock, envíos nuevos por `wa-mock/graph`; desconectar → webhook borrado, bandeja intacta.

- [x] T037 [US5] En `PUT /api/settings/whatsapp` (`src/app/api/settings/whatsapp/route.ts`): si la conexión previa es Kapso y la nueva es Meta, `borrarWebhook` en Kapso (best-effort) antes de guardar; si la previa es Meta y la nueva Kapso, `unregisterWebhookForNumber` en Meta con el token viejo (best-effort)
- [x] T038 [US5] En `DELETE /api/settings/whatsapp`: con conexión Kapso, `borrarWebhook` (best-effort) en lugar de `unregisterWebhookForNumber`; luego `desconectarCanal`; 200 aunque Kapso falle, con aviso en la respuesta
- [x] T039 [US5] En `src/components/settings/whatsapp-wizard.tsx`, mostrar el aviso de la respuesta cuando no se pudo retirar el webhook en Kapso ("Quítalo a mano en el panel de Kapso")

**Checkpoint**: todas las historias completas.

---

## Phase 8: Polish, E2E y documentación

**Purpose**: self-test de comportamiento, docs y prueba en vivo.

- [x] T040 Crear `scripts/e2e-kapso.mjs` (estilo de `scripts/e2e-messenger.mjs`) que recorre quickstart §2–§7: bandera, conectar (bien y llave revocada), alta del webhook, recibir (texto, duplicado, firma inválida, sin firma, imagen, eco), evento por la ruta de Meta descartado, responder (texto, imagen, plantilla), 429 sin reconexión, llave revocada → `reconnect_required`, Laboratorio sin salida, cambio a Meta, desconectar. Sale con código 1 si algo falla
- [x] T041 [P] Escribir el guion `tests/e2e/us-kapso.md` con los mismos pasos en lenguaje de operador
- [x] T042 [P] Escribir `docs/kapso.md` (guía para agencias): cuándo conviene, cómo conectar, qué hace Vocero en Kapso, límites por plan (research R3), qué no hace en v1 (alta de números, sandbox, llamadas, Flows), plantillas por sincronización, cómo pegar el webhook a mano
- [x] T043 [P] Agregar la fila del conector Kapso al mapa del código en `AGENTS.md` y `CLAUDE.md`, la entrada 031 en `specs/README.md` y una línea en `CHANGELOG.md`
- [x] T044 Correr el gate técnico en las dos configuraciones (sin banderas, y `CHANNELS=whatsapp,instagram,messenger,tiktok AGENDA=on KAPSO=on`), `pnpm test:e2e` y `node --env-file=.env scripts/e2e-kapso.mjs` con la app viva y los mocks; corregir hasta verde
- [ ] T045 Prueba en vivo V1–V5 (quickstart §8) con un número de prueba en Kapso y la instancia en HTTPS; anotar resultados en `specs/031-conector-kapso/research.md` → "Pendientes de verificación en vivo". Si no hay número disponible, marcar SC-007 como **pendiente de verificación humana** (Principio V)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (1)**: sin dependencias.
- **Foundational (2)**: depende de Setup. T008–T012 (refactor) bloquean todo; T013–T016 dependen de T009.
- **US1 (3)**: depende de Foundational.
- **US2 (4)**: depende de Foundational y de T017–T018 + T021 (el mock solo entrega a webhooks registrados al conectar). La firma (T024–T025) se puede hacer en paralelo con US1.
- **US3 (5)**: depende de Foundational; para la prueba de punta a punta necesita US1 (conexión) y US2 (conversación abierta).
- **US4 (6)**: T032 depende de T027 (`processPayload` compartido); el resto, de Foundational.
- **US5 (7)**: depende de US1 (T017, T021).
- **Polish (8)**: depende de todo lo anterior.

### Story completion order

```
Setup → Foundational (refactor ✔ checkpoint) → US1 → US2 → US3 → US4 → US5 → Polish
                                               └─ T024/T025 en paralelo con US1
```

### Within each story

Tests unitarios de la pieza junto con ella (no TDD estricto); el E2E (T040) al final porque recorre todas las historias.

---

## Parallel Example

```text
# Setup:
T002 .env.example   |  T003 src/server/kapso/flag.ts

# Foundational, tras T009:
T013 kapso-mock-state.ts  |  T016 tests/unit/kapso-transport.test.ts (contra fetch falso)
T007 tests/unit/whatsapp-credentials-fuente.test.ts (tras T006)

# US1 + inicio de US2:
T017 src/server/kapso/webhooks.ts  |  T018 mock de plataforma  |  T024 src/server/kapso/firma.ts  |  T025 test de firma

# US4:
T034 test de convivencia  |  T035 test de frontera

# Polish:
T041 guion  |  T042 docs/kapso.md  |  T043 mapas y changelog
```

---

## Implementation Strategy

### MVP

1. Setup + Foundational → **pausa**: el refactor del transporte (T008–T012) se revisa y, si se quiere, se fusiona solo.
2. US1 + US2 + US3 → un número de Kapso conecta, recibe y responde contra el mock.
3. Validar con quickstart §3–§5 antes de seguir.

### Incremental delivery

1. MVP (US1–US3).
2. US4: convivencia y CI → requisito para fusionar a `main` (Principio II.5).
3. US5: cambio de fuente y desconexión.
4. Polish: E2E completo, docs, prueba en vivo.

---

## Notes

- Cada tarea termina con el gate técnico verde; las que tocan envío o ingesta, además con `pnpm test:e2e`.
- Nada de esto usa el MCP ni la CLI de Kapso en runtime; la CLI solo aparece como ayuda en el wizard y en la guía.
- Commit por tarea o por grupo lógico, con prefijo `feat(031)` / `test(031)` / `docs(031)`.
