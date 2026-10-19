# Conector Kapso para WhatsApp (031)

Guía para agencias que ya tienen los números de sus clientes en
[Kapso](https://kapso.ai) y quieren operarlos desde Vocero. Spec:
[`specs/031-conector-kapso/spec.md`](../specs/031-conector-kapso/spec.md).

## Cuándo conviene

Kapso es un proveedor que conecta números de WhatsApp a la Cloud API de Meta
por ti (es Tech Provider). Úsalo con Vocero cuando:

- el número del cliente ya vive en tu proyecto de Kapso y no quieres
  rehacer el alta en una app de Meta propia, o
- no tienes (ni quieres tener) una app de Meta verificada.

Si el negocio tiene su propia app de Meta, el modo directo de siempre sigue
siendo el camino más corto: no hace falta este conector.

## Encenderlo

Es un conector opcional (ADR-001): apagado por defecto.

```bash
KAPSO=on
```

Agrega la variable en la plataforma donde despliegas y **redespliega** (un
reinicio no carga variables nuevas). La llave de Kapso **no** va en el entorno:
se pega en la app y se guarda cifrada. `KAPSO_BASE_URL` solo existe para apuntar
a un mock en pruebas; en producción no la definas.

La instancia debe estar publicada en **https**: Kapso solo reenvía a URLs https.

## Conectar un número

1. Configuración → WhatsApp → **Kapso**.
2. Pega la **llave del proyecto** (panel de Kapso → API keys), el **Phone
   Number ID** y el **WABA ID**. Los dos IDs son los de Meta; con la CLI:

   ```bash
   kapso whatsapp numbers resolve --phone-number +5255… --output json
   ```

3. **Probar conexión**: Vocero pide el número a Kapso con esa llave y te enseña
   el número y el nombre verificado. Si la llave no sirve, no se guarda nada.
4. **Guardar**. Vocero genera un secreto de firma, guarda llave y secreto
   cifrados y da de alta en Kapso el reenvío del número: un webhook tipo
   **Meta** que apunta a `https://<tu-dominio>/api/webhooks/wa-kapso/<token>`.
   La tarjeta dice «Registrado en Kapso».

### Si el alta automática falla

La conexión queda guardada igual. La tarjeta enseña la URL y el secreto **una
sola vez**: en el panel de Kapso → el número → Webhooks, crea uno de tipo
**Meta** con esa URL y ese secreto. O reintenta con «Registrar en Kapso». Si
perdiste el secreto, vuelve a guardar la conexión para generar otro.

## Qué hace Vocero en Kapso

| Acción | Llamada |
|---|---|
| Enviar texto, adjuntos, ubicación, plantillas, «escribiendo…» | Proxy de la Cloud API: `/meta/whatsapp/v24.0/…` con `X-API-Key` |
| Descargar un adjunto entrante | Metadata con `phone_number_id` y descarga por el `download_url` firmado (sin cabeceras) |
| Recibir | El reenvío tipo Meta: el payload de Meta tal cual, firmado con `X-Webhook-Signature` (HMAC-SHA256 hex) |
| Dar de alta, actualizar o retirar el reenvío | Platform API: `/platform/v1/whatsapp/phone_numbers/{id}/webhooks` |

Un evento sin firma válida se rechaza (401). Un número conectado por Kapso
**solo** recibe por su ruta firmada: si el mismo evento llega por la ruta de
Meta, se descarta.

## Límites y diferencias con el modo directo

- **Cuota por llave**: Kapso limita por minuto según el plan (Free 100, Pro
  1000, Platform 2000, Enterprise 4000). Una bandeja normal queda muy por
  debajo. Si se pasa, el envío falla como «no disponible» y se puede
  reintentar; la conexión no se marca para reconectar.
- **Plantillas**: Kapso no reenvía el cambio de estado de las plantillas. El
  estado se actualiza al abrir Configuración → Plantillas (como mucho una vez
  por minuto) o con «Actualizar estado».
- **Llave revocada**: los envíos se pausan y la bandeja avisa «Kapso rechazó la
  llave del proyecto». Se reconecta pegando una llave vigente.

## Qué no hace en esta versión

- Dar de alta números nuevos (setup links) desde Vocero: el número se conecta
  en Kapso y se pega aquí.
- El sandbox de Kapso, llamadas de WhatsApp y Flows.

## Cambiar de fuente o desconectar

- **Pasar el número a Meta directo**: guarda la conexión eligiendo «Meta». Vocero
  retira el reenvío en Kapso con la llave vieja. El historial no cambia.
- **Pasar de Meta a Kapso**: igual, al revés; se quita el override del número
  en Meta.
- **Desconectar**: retira el reenvío en Kapso y borra las credenciales. La
  bandeja se queda.

Si Kapso no responde en ese momento, la operación se completa igual y un aviso
pide quitar el webhook a mano en el panel de Kapso.

## Con la bandera apagada

Si apagas `KAPSO` con un número conectado por Kapso, la conexión se sigue
viendo con un aviso, pero no envía ni recibe: los envíos fallan con «El
conector Kapso está apagado en esta instancia» (sin marcar reconexión) y la
ruta del reenvío responde 404. Enciende la bandera o conecta el número directo
con Meta.

## Probarlo sin Kapso

Todo el flujo corre contra un mock local. Ver
[`quickstart.md`](../specs/031-conector-kapso/quickstart.md) y el guion
[`tests/e2e/us-kapso.md`](../tests/e2e/us-kapso.md):

```bash
node --env-file=.env scripts/e2e-kapso.mjs
```
