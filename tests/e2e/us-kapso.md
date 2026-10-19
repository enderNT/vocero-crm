# E2E — Conector Kapso para WhatsApp (031)

Arnés: `scripts/e2e-kapso.mjs`. Spec:
[`specs/031-conector-kapso/spec.md`](../../specs/031-conector-kapso/spec.md).
Guía: [`docs/kapso.md`](../../docs/kapso.md).

Precondición: app corriendo (`next dev`) sobre una base migrada, con mocks
(`WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock, `OPENROUTER_BASE_URL`
→ ai-mock con `OPENROUTER_API_TOKEN` y `OPENROUTER_MODEL`), `KAPSO=on` y
`KAPSO_BASE_URL=<app>/api/dev/kapso-mock`.

El arnés hace de **Kapso**: el mock del proxy acepta la llave
`kapso_test_key` solo en `X-API-Key` (un `Authorization` es 401, así que si un
envío llega, no llevó Bearer); el mock de la Platform API guarda los webhooks
dados de alta; `POST /api/dev/kapso-mock/inbound` entrega el payload de Meta a
la URL registrada, firmado con su secreto; `POST /api/dev/kapso-mock/state`
programa un 429/503 o revoca la llave.

```bash
node --env-file=.env scripts/e2e-kapso.mjs
```

## Conectar (US1)

1. Probar con `kapso_revoked_key` → 422 «Kapso rechazó la llave del proyecto».
   Guardar con ella → 422 y la conexión no cambia.
2. Probar con `kapso_test_key` → número y nombre verificado.
3. Guardar → 200, «Registrado en Kapso» y la respuesta **sin** secreto. En el
   mock: un solo webhook `kind: meta` para el número, con secreto, apuntando a
   `/api/webhooks/wa-kapso/<token>`.
4. `GET /api/settings/whatsapp` → `source: kapso`, últimos 4 de la llave,
   `webhookRegistered`, nunca el secreto. `GET /api/settings/webhook` →
   proveedor Kapso, sin verify token.
5. «Registrar en Kapso» otra vez → actualiza, sigue habiendo un webhook.

## Recibir (US2)

6. Sin firma → 401. Firma con otro secreto → 401. Nada entra a la bandeja.
7. Texto firmado, entregado dos veces → 200 y un solo mensaje.
8. Imagen con enlace que vence la primera vez → se descarga con el enlace nuevo
   y queda `available`.
9. Eco (mensaje mandado desde la app del teléfono) → saliente manual.
10. El mismo número por la ruta de Meta → la ruta responde 200, pero el
    evento se descarta.

## Responder (US3)

11. Texto, imagen con pie, ubicación y plantilla (creada, aprobada al
    sincronizar y enviada) → todo llega al proxy de Kapso.
12. La sincronización automática de plantillas va como mucho una vez por
    minuto; la pantalla avisa que con Kapso el estado se actualiza al
    sincronizar.
13. Un 429 de Kapso → el envío falla como `meta_unavailable` y la conexión
    sigue `connected`.
14. Llave revocada → `reconnect_required` con mensaje de Kapso; reconectar con
    la llave vigente la deja `connected`.

## Convivir (US4)

15. Una corrida del Laboratorio no manda nada al proxy de Kapso.
16. **Bandera apagada** (reinicia la app sin `KAPSO` y vuelve a correr el
    arnés): la opción no existe; probar o guardar con `source: kapso` → 404;
    `POST /api/webhooks/wa-kapso/<token>` → 404; la conexión Kapso guardada se
    ve, enviar falla con «El conector Kapso está apagado» y no marca
    reconexión.

## Cambiar de fuente y desconectar (US5)

17. Guardar el mismo número por Meta → el webhook en Kapso se retira, la
    conexión es Meta, el historial no cambia y el envío sale por Meta. Un
    reenvío de Kapso ya no tiene a dónde ir.
18. Volver a Kapso → registrado otra vez, un solo webhook.
19. Desconectar → 200, el webhook se retira, no hay conexión y la bandeja se
    queda.
20. Desconectar con Kapso caído → 200 igual, con aviso de quitarlo a mano.

El arnés termina dejando el número conectado por Kapso para el paso 16.

## Prueba en vivo (pendiente de verificación humana)

Contra un número de prueba en Kapso y la instancia en https: quickstart §8
(V1–V5). Lo que solo se sabe en vivo está en `research.md` → «Pendientes de
verificación en vivo».
