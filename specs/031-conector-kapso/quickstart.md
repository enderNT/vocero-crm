# Quickstart — probar el conector Kapso de punta a punta

Feature: `031-conector-kapso`. Todo el alcance se ejercita en localhost contra el
mock de Kapso, **sin tocar Kapso ni Meta**. La prueba en vivo (sección 8) es
aparte y necesita un número de prueba conectado en un proyecto de Kapso.

## 1. Entorno

```bash
# .env (además de lo habitual: DATABASE_URL, BETTER_AUTH_SECRET, ENCRYPTION_KEY…)
KAPSO=on                                          # la bandera de esta feature
WA_MOCK_ENABLED=true
META_GRAPH_BASE_URL=http://localhost:3000/api/dev/wa-mock/graph
KAPSO_BASE_URL=http://localhost:3000/api/dev/kapso-mock
OPENROUTER_BASE_URL=http://localhost:3000/api/dev/ai-mock
```

App viva con la BD migrada (`pnpm db:migrate`). El arnés automático hace todo lo
de abajo:

```bash
node --env-file=.env scripts/e2e-kapso.mjs
```

## 2. La bandera, primero apagada

1. Arranca **sin** `KAPSO` → Configuración → WhatsApp no menciona Kapso;
   `POST /api/webhooks/wa-kapso/<token>` → **404**; un `PUT
   /api/settings/whatsapp` con `source: "kapso"` → **404**.
2. Los self-tests existentes (`pnpm test:e2e`) en verde.
3. Arranca con `KAPSO=on` → la opción aparece; la migración ya estaba aplicada.

## 3. Conectar por Kapso

1. Configuración → WhatsApp → **Kapso**: llave `kapso_test_key`, cualquier
   `phoneNumberId` y `wabaId` del mock → **Probar conexión** muestra número y
   nombre verificado.
2. Llave `kapso_revoked_key` → "Kapso rechazó la llave del proyecto"; nada se
   guarda.
3. **Guardar** → la tarjeta del webhook dice "Registrado en Kapso".
   Comprobar en el mock: un webhook `kind: meta` para ese número, con la URL
   `…/api/webhooks/wa-kapso/<token>`.
4. `GET /api/settings/whatsapp` → `source: "kapso"`, `tokenLast4`, sin secreto.

## 4. Recibir

```bash
curl -X POST localhost:3000/api/dev/kapso-mock/inbound -H 'content-type: application/json' -d '{
  "phoneNumberId": "<el conectado>", "from": "5215500001111", "name": "Marina",
  "text": "hola por Kapso"
}'
```

- El mensaje aparece en la bandeja.
- Mismo cuerpo con `"duplicate": true` → un solo mensaje.
- `"badSignature": true` y `"noSignature": true` → la ruta responde 401 y no
  aparece nada.
- `"media": { "type": "image" }` → la imagen se ve en la bandeja (el mock
  comprueba que la descarga no llevó cabeceras de auth).
- `"echo": true` → aparece como saliente manual y la IA queda en pausa (008).
- El mismo evento enviado a la ruta **de Meta** (`/api/dev/wa-mock/inbound`
  con ese número) → descartado: no aparece.

## 5. Responder

Desde la bandeja: texto, imagen, ubicación y una plantilla (con la ventana
cerrada). Comprobar en `GET /api/dev/wa-mock/outbox` que cada envío llegó por el
proxy de Kapso con `X-API-Key` (el mock rechaza Bearer, así que si llegó, no
hubo Bearer).

Camino infeliz:
- Envío con `x-mock-fail: 429` → mensaje fallido reintentable; la conexión
  sigue `connected`.
- Cambiar la llave guardada por `kapso_revoked_key` (reconectar) y enviar →
  `reconnect_required` y aviso en la bandeja.

## 6. Convivir

- Conversación del Laboratorio → el outbox del mock no recibe nada.
- Con `CHANNELS=whatsapp,messenger`: enviar por Messenger sale por
  `wa-mock/graph` con Bearer, no por Kapso.
- Cambiar a **modo directo** con el mismo número → historial intacto; el
  webhook de Kapso se borra del mock; lo nuevo sale por `wa-mock/graph`.

## 7. Desconectar

Configuración → WhatsApp → **Desconectar** → el webhook desaparece del mock; la
bandeja conserva las conversaciones.

## 8. Prueba en vivo (verificación humana si no hay número)

Con un número de prueba conectado en Kapso y la instancia publicada en HTTPS:

1. `KAPSO=on`, sin `KAPSO_BASE_URL` (usa `https://api.kapso.ai`).
2. Conectar con la llave real del proyecto.
3. Escribir al número desde un teléfono → entra a la bandeja (V1).
4. Mandar una imagen → se ve (V2).
5. Responder desde la bandeja → llega al teléfono.
6. Si el número está en coexistencia, escribir desde la app del teléfono →
   aparece como manual (V3).
7. Crear una plantilla y anotar si su aprobación llega sola o solo con
   "Sincronizar" (V4).

Anotar los resultados en `research.md` → "Pendientes de verificación en vivo".
