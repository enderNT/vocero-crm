# Feature Specification: Conector opcional Kapso para el canal WhatsApp

**Feature Branch**: `031-conector-kapso`

**Created**: 2026-10-17

**Status**: Draft

**Input**: User description: "Conector opcional Kapso para el canal WhatsApp: permitir que una instancia de Vocero use Kapso (proxy de la WhatsApp Cloud API) como transporte en lugar de una app de Meta propia, detrás de bandera, sin romper el modo directo ni el modo agencia."

**Carril**: ciclo completo. Toca el modelo de datos (la conexión de WhatsApp
gana una fuente), una superficie pública (el webhook de WhatsApp acepta una
segunda firma) y mete un tercero en runtime, que solo puede entrar como
conector opcional (Principio II, condiciones 1–5; patrón ADR-001, precedente
Zernio en 014/017/030).

## Problema

Hoy Vocero solo habla WhatsApp de una manera: el negocio tiene una app de Meta
(propia o de su agencia), pega un token de usuario del sistema, y Vocero llama a
Meta con ese token y registra el webhook en Meta él mismo.

Muchas agencias no tienen ni quieren mantener una app de Meta: conectan los
números de sus clientes en **Kapso**, que es Tech Provider, hace el alta del
número (embedded signup / setup links), puede pagar la facturación de Meta y
expone la misma API de WhatsApp a través de su propio proxy con una llave de
proyecto. Para esas agencias Vocero hoy es inutilizable sin fork: no hay dónde
poner la llave de Kapso, Vocero intenta registrar un webhook en una app de Meta
que no controla, la firma de los eventos que llegan no es la de Meta y los
adjuntos entrantes no se pueden descargar.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Conectar un número que vive en Kapso (Priority: P1)

El propietario de una instancia con el conector encendido entra a Configuración
→ WhatsApp, elige "Kapso" como forma de conexión, pega la llave de su proyecto de
Kapso y el identificador del número (y el de la cuenta de WhatsApp Business), y
prueba la conexión antes de guardar. Vocero le confirma el número visible y el
nombre verificado, guarda la conexión y deja listo el aviso de mensajes: o lo
configura solo en Kapso, o —si no puede— le muestra la URL y el secreto que tiene
que pegar en el panel de Kapso.

**Why this priority**: sin conexión no existe nada más; es la puerta de entrada
del conector y por sí sola ya prueba que la llave y el número son válidos.

**Independent Test**: con la bandera encendida y el mock de Kapso, conectar un
número desde la pantalla de ajustes y ver el número y nombre verificados; con
una llave inválida, ver un error claro sin que se guarde nada.

**Acceptance Scenarios**:

1. **Given** la bandera del conector encendida y un número conectado en Kapso,
   **When** el propietario pega una llave válida y el identificador del número y
   pulsa "Probar conexión", **Then** ve el número visible y el nombre verificado
   que reporta el proveedor.
2. **Given** una llave inválida o revocada, **When** prueba la conexión,
   **Then** ve un mensaje que dice que la llave fue rechazada y la conexión no se
   guarda.
3. **Given** una conexión guardada por Kapso, **When** el propietario vuelve a la
   pantalla, **Then** ve la fuente "Kapso", el número y solo los últimos 4
   caracteres de la llave.
4. **Given** una conexión guardada, **When** Vocero no logra dar de alta el aviso
   de mensajes en Kapso, **Then** la conexión queda guardada igual, el
   propietario ve la URL y el secreto para configurarlo a mano, y un botón para
   reintentar.

---

### User Story 2 - Recibir mensajes por Kapso (Priority: P1)

Un cliente escribe al número del negocio. Kapso reenvía el evento a Vocero y el
mensaje aparece en la bandeja en tiempo real, con contacto y conversación nuevos
si no existían, y el agente responde si está activo — exactamente igual que con
una app de Meta.

**Why this priority**: es el valor central del CRM; sin recepción la bandeja
está vacía.

**Independent Test**: inyectar al webhook un evento firmado como lo firma Kapso
y ver el mensaje en la bandeja; reinyectar el mismo evento y comprobar que no se
duplica; inyectarlo con firma inválida y ver que se rechaza sin efectos.

**Acceptance Scenarios**:

1. **Given** una conexión por Kapso, **When** llega un mensaje de texto firmado
   correctamente, **Then** aparece en la bandeja, enrutado a la organización
   dueña de ese número.
2. **Given** el mismo evento entregado dos veces, **When** se procesa, **Then**
   existe un solo mensaje y el agente responde una sola vez.
3. **Given** un evento con firma ausente o inválida, **When** llega al webhook,
   **Then** se rechaza y no crea ni modifica nada.
4. **Given** un mensaje con imagen, audio o documento, **When** se ingesta,
   **Then** el adjunto se descarga y se ve en la bandeja como con Meta.
5. **Given** un evento de un contacto que solo trae identificador de negocio
   (sin teléfono), **When** se ingesta, **Then** se crea o encuentra el contacto
   por esa identidad, igual que hoy.

---

### User Story 3 - Responder y operar por Kapso (Priority: P1)

El operador o el agente responden desde la bandeja: texto, adjuntos, ubicación,
contactos, mensajes interactivos, marcado de leído e indicador de "escribiendo";
fuera de la ventana de 24 h, plantillas aprobadas. Todo sale por Kapso con la
llave del negocio. El propietario puede crear y sincronizar plantillas desde
Vocero como hoy.

**Why this priority**: recibir sin poder contestar no sirve; junto con US1 y US2
forma el MVP del conector.

**Independent Test**: contra el mock de Kapso, enviar cada tipo de mensaje desde
la bandeja y verificar que el mock recibió la petición con la llave del negocio
(y no con un token de Meta); enviar una plantilla fuera de ventana.

**Acceptance Scenarios**:

1. **Given** una conversación abierta por Kapso, **When** el operador envía un
   texto, **Then** el mensaje llega al cliente y en la bandeja pasa a enviado.
2. **Given** un adjunto saliente, **When** se envía, **Then** se sube por Kapso y
   llega al cliente.
3. **Given** la ventana de 24 h cerrada, **When** el operador intenta texto libre,
   **Then** Vocero le exige una plantilla aprobada, igual que hoy, y la plantilla
   sale por Kapso.
4. **Given** la llave revocada en Kapso, **When** se intenta enviar, **Then** la
   conexión pasa a "requiere reconexión", el operador ve el aviso y el mensaje
   queda marcado como fallido (no se pierde en silencio).
5. **Given** el propietario pulsa "Sincronizar plantillas", **When** la
   sincronización termina, **Then** ve las plantillas de su cuenta con su estado.

---

### User Story 4 - Convivir con los modos existentes (Priority: P2)

Una instancia con la bandera apagada no cambia en nada. Una instancia con la
bandera encendida sigue pudiendo conectar en modo directo o modo agencia; solo
gana la opción Kapso. Instagram, Messenger, TikTok, la atribución de anuncios y
el Laboratorio siguen igual.

**Why this priority**: el conector no puede romper lo que ya funciona
(Principio II.3 y II.5); es un requisito de no-regresión, no valor nuevo.

**Independent Test**: correr los self-tests existentes con la bandera apagada y
encendida y verlos en verde; con la bandera apagada, verificar que la opción
Kapso no aparece y su superficie responde 404.

**Acceptance Scenarios**:

1. **Given** la bandera apagada, **When** el propietario abre Configuración →
   WhatsApp, **Then** no ve ninguna mención a Kapso y cualquier superficie propia
   del conector responde 404.
2. **Given** la bandera encendida y una conexión en modo directo, **When** se
   envían y reciben mensajes, **Then** todo funciona como antes, con la firma de
   Meta.
3. **Given** una conversación de prueba del Laboratorio en una instancia por
   Kapso, **When** el agente responde, **Then** no sale ninguna petición real a
   Kapso (el guardrail del sandbox se mantiene).
4. **Given** una instancia por Kapso con Messenger encendido, **When** se envía
   por Messenger, **Then** sigue saliendo directo a Meta, no por Kapso.

---

### User Story 5 - Cambiar de fuente o desconectar (Priority: P3)

El propietario puede pasar de Kapso a modo directo (o al revés) o desconectar el
canal. Al desconectar una conexión de Kapso, Vocero intenta retirar el aviso de
mensajes que había dado de alta en Kapso.

**Why this priority**: operación de mantenimiento; poco frecuente pero necesaria
para que una agencia migre un cliente sin tocar la base de datos.

**Independent Test**: conectar por Kapso, cambiar a modo directo y verificar que
los mensajes nuevos se firman y envían por Meta y que el historial sigue ahí.

**Acceptance Scenarios**:

1. **Given** una conexión por Kapso con historial, **When** el propietario la
   reemplaza por una en modo directo con el mismo número, **Then** contactos,
   conversaciones y mensajes se conservan y lo nuevo sale por Meta.
2. **Given** una conexión por Kapso, **When** el propietario desconecta, **Then**
   la llave se borra, Vocero intenta retirar el aviso en Kapso, y si no puede lo
   avisa sin bloquear la desconexión.

### Edge Cases

- **Proveedor caído o lento**: un envío que falla por error transitorio del
  proveedor queda como fallido reintentable; nunca tumba el turno del agente ni
  marca la conexión como "requiere reconexión" (solo un rechazo de credencial lo
  hace).
- **Adjunto vencido**: el enlace de descarga del proveedor expira en minutos; si
  la descarga se hace tarde, se pide uno nuevo una vez antes de rendirse, y el
  mensaje entra igual con su tipo aunque el archivo no se pueda bajar.
- **Número ya usado**: si el número ya está conectado en esta instancia por otra
  fuente, la conexión nueva lo reemplaza (un número = una conexión), no crea dos.
- **Evento de un número desconocido**: se descarta y se registra, como hoy.
- **Eventos que el proveedor no reenvía**: si Kapso no reenvía el cambio de
  estado de plantillas o los mensajes enviados desde el teléfono (coexistencia),
  la instancia sigue funcionando; las plantillas se ponen al día con la
  sincronización y la pantalla lo dice.
- **Secreto del webhook ausente**: con Kapso el secreto es obligatorio; una
  conexión por Kapso sin secreto no acepta eventos (no hay modo "sin firma").
- **Reintentos del proveedor**: el mismo evento entregado varias veces por
  Kapso no duplica nada (Principio IV).
- **Bandera apagada con conexión Kapso guardada**: si alguien apaga la bandera
  teniendo una conexión por Kapso, el canal queda inactivo con un aviso claro en
  ajustes; no se intenta enviar por Meta con la llave de Kapso.

## Requirements *(mandatory)*

### Functional Requirements

**Bandera y aislamiento**

- **FR-001**: El conector MUST estar apagado por defecto y encenderse solo con
  una bandera de despliegue explícita. Con la bandera apagada, la UI no lo
  menciona, no pide sus credenciales y toda superficie propia responde 404.
- **FR-002**: Todo lo específico de Kapso MUST vivir detrás de un adaptador
  dedicado; el resto del sistema (bandeja, agente, plantillas, Laboratorio) no
  sabe por qué transporte sale o entra un mensaje.
- **FR-003**: La elección de transporte MUST ser por conexión de WhatsApp, no
  global: los demás canales que hablan con Meta (Messenger, atribución de
  anuncios) siguen hablando directo con Meta aunque WhatsApp vaya por Kapso.

**Conexión**

- **FR-004**: La conexión de WhatsApp MUST registrar su fuente (Meta directo/
  agencia, o Kapso). Las conexiones existentes quedan como Meta sin intervención.
- **FR-005**: Para una conexión por Kapso, el propietario MUST poder introducir
  la llave del proyecto de Kapso, el identificador del número y el de la cuenta
  de WhatsApp Business, y probarlos antes de guardar.
- **FR-006**: La llave de Kapso y el secreto del webhook MUST guardarse cifrados
  en reposo con el mecanismo existente; hacia el navegador solo viajan los
  últimos 4 caracteres de la llave, y nunca aparecen en logs.
- **FR-007**: Al guardar una conexión por Kapso, el sistema MUST NOT intentar
  registrar el webhook en Meta.
- **FR-008**: Al guardar una conexión por Kapso, el sistema SHOULD dar de alta
  en Kapso un aviso de mensajes en **formato Meta** apuntando a la URL secreta
  del webhook de la instancia, con un secreto generado por Vocero. Si no puede,
  la conexión se guarda igual y la pantalla muestra URL y secreto para hacerlo a
  mano, con opción de reintentar (mismo trato "best-effort" que el modo directo).

**Recepción**

- **FR-009**: El webhook de WhatsApp MUST aceptar eventos reenviados por Kapso en
  formato Meta por la misma URL secreta, y procesarlos con la misma ingesta que
  los de Meta (enrutado por identificador de número, idempotencia, identidad
  resiliente, ecos, estados de plantilla cuando lleguen).
- **FR-010**: Para conexiones por Kapso, el sistema MUST verificar la firma de
  Kapso sobre el cuerpo crudo con el secreto de esa conexión y rechazar sin
  efectos los eventos con firma ausente o inválida. La verificación de Meta para
  las demás conexiones no cambia.
- **FR-011**: Los adjuntos entrantes de una conexión por Kapso MUST descargarse a
  través del proveedor con la llave del negocio, respetando los límites de tamaño
  actuales, y el mensaje MUST entrar aunque la descarga falle.

**Envío y operación**

- **FR-012**: Todo lo que hoy sale a Meta por WhatsApp (texto, adjuntos subidos,
  ubicación, contactos, interactivos, plantillas, marcado de leído, "escribiendo",
  creación y sincronización de plantillas, prueba de conexión) MUST salir por
  Kapso con la llave del negocio cuando la conexión es por Kapso.
- **FR-013**: Las reglas de negocio de envío (ventana de 24 h, normalización del
  destinatario, guardrail del Laboratorio, idempotencia de envío) MUST aplicarse
  igual, antes de elegir transporte.
- **FR-014**: Un rechazo de credencial por parte de Kapso MUST marcar la conexión
  como "requiere reconexión"; un error transitorio MUST NOT hacerlo.
- **FR-015**: Los errores de Kapso MUST traducirse a los mismos mensajes que ve
  hoy el operador para los errores de Meta equivalentes (destinatario no válido,
  fuera de ventana, plantilla no aprobada…).
- **FR-016**: La superficie de cerebro externo (bot propio del negocio) MUST
  funcionar igual con una conexión por Kapso, sin que la llave salga del CRM.

**Verificación**

- **FR-017**: El entorno de pruebas MUST incluir un mock de Kapso (envío, subida y
  descarga de adjuntos, plantillas, alta de webhook, eventos firmados) con camino
  infeliz (llave rechazada, error transitorio, adjunto vencido).
- **FR-018**: La CI MUST ejercitar el sistema con el conector apagado y encendido,
  y el self-test E2E MUST cubrir conectar, recibir, responder y desconectar por
  Kapso.

### Key Entities *(include if feature involves data)*

- **Conexión de WhatsApp**: la que ya existe (una por organización, un número
  por conexión). Gana un atributo **fuente** (Meta | Kapso). Con Kapso guarda la
  llave del proyecto (cifrada), el identificador del número y de la cuenta, el
  secreto del webhook (cifrado) y, si se dio de alta, la referencia del aviso de
  mensajes en Kapso para poder retirarlo.
- **Aviso de mensajes en Kapso**: registro en el proveedor que reenvía los eventos
  del número en formato Meta a la URL secreta de la instancia. Uno por número.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Una agencia con un número ya conectado en Kapso deja una instancia
  recibiendo y respondiendo mensajes en menos de 10 minutos desde que abre
  Configuración → WhatsApp, sin crear una app de Meta.
- **SC-002**: El 100 % de los self-tests existentes pasa sin cambios con la
  bandera apagada, y también con la bandera encendida y una conexión en modo
  directo.
- **SC-003**: El self-test E2E del conector (conectar, recibir texto y adjunto,
  responder texto, adjunto y plantilla, evento duplicado, firma inválida, llave
  revocada, desconectar) queda en verde contra el mock.
- **SC-004**: Un evento entregado N veces produce exactamente un mensaje y, como
  mucho, una respuesta del agente.
- **SC-005**: Ningún evento con firma inválida produce efectos observables.
- **SC-006**: Ninguna conversación del Laboratorio produce peticiones reales a
  Kapso.
- **SC-007**: Un mensaje real enviado al número entra a la bandeja y una respuesta
  desde la bandeja llega al teléfono (verificación en vivo con un número de
  prueba del propietario; pendiente de verificación humana si no hay número
  disponible).

## Assumptions

- **Hechos verificados del proveedor** (documentación de Kapso y skill
  `integrate-whatsapp`, revisados el 2026-10-17; el plan los vuelve a confirmar
  en `research.md`):
  - Kapso expone un proxy que replica las formas de la API de WhatsApp de Meta;
    se autentica con una llave de proyecto en una cabecera propia, no con token
    de Meta. La versión documentada de la ruta es `v24.0`.
  - Un aviso de mensajes de tipo "meta" reenvía el payload crudo de Meta del
    número, firmado con HMAC-SHA256 en hexadecimal sobre el cuerpo crudo, sin el
    prefijo `sha256=`, con el secreto que elige el cliente (obligatorio). Solo se
    permite uno por número. No hay desafío de verificación inicial.
  - Los adjuntos se piden por id indicando el número y el proxy devuelve un
    enlace de descarga con la autenticación incluida, válido unos 4 minutos.
  - El proxy no expone la suscripción de apps ni la configuración de webhook de
    Meta (no hacen falta en este modo).
- **No verificado**: si el aviso tipo "meta" incluye los cambios de estado de
  plantillas (evento a nivel de cuenta) y los ecos de coexistencia. Se asume que
  puede que no; el diseño degrada a sincronización de plantillas y lo dice en la
  pantalla. El plan debe confirmarlo con una prueba real o con Kapso.
- **Fuera de alcance v1**: dar de alta números nuevos desde Vocero (setup links,
  provisión de números), números sandbox de Kapso, llamadas de WhatsApp, Flows,
  broadcasts de Kapso, workflows de Kapso, facturación administrada, y la
  Conversions API de anuncios vía Kapso. El número se conecta primero en Kapso.
- **Formato de eventos**: se usa solo el reenvío en formato Meta, no los eventos
  propios de Kapso, para reutilizar la ingesta existente sin un traductor.
- **Una instancia = un negocio = un número**: se mantiene la regla actual de una
  conexión de WhatsApp por organización.
- **Credenciales del propio negocio**: cada instancia usa la llave del proyecto de
  Kapso del negocio o de su agencia; Vocero nunca trae una llave central
  (Principio II.4). El costo de Kapso lo asume quien enciende la bandera.
- **Sin dependencia del MCP de Kapso** ni de su CLI en runtime: el conector habla
  con la API pública.

## Constitution Check (previo al plan)

- **I. Seguridad de datos**: llave y secreto cifrados con el AES-256-GCM
  existente; solo los últimos 4 hacia fuera; nada en logs (FR-006).
- **II. Soberanía**: entra como conector opcional y cumple las cinco condiciones:
  apagado por defecto (FR-001), adaptador dedicado (FR-002), la instancia sigue
  completa con modo directo/agencia y degrada definido ante fallos del proveedor
  (US4, Edge Cases), credenciales del negocio cifradas (FR-006), CI apagado y
  encendido con mock y camino infeliz (FR-017, FR-018).
- **III. Multi-tenancy**: la conexión sigue siendo por organización; el enrutado
  por número no cambia.
- **IV. Idempotencia**: misma deduplicación por id de mensaje para eventos
  reenviados por Kapso (US2.2, SC-004).
- **V. Calidad verificable**: gates + self-test E2E con mock; la verificación en
  vivo queda marcada como pendiente humana si no hay número (SC-007).
- **VI. Specs antes de código**: este documento.
