/**
 * 031 — Si esta instancia ofrece el conector Kapso para el canal WhatsApp.
 *
 * Mismo trato que los canales opcionales (ADR-001), la agenda y la atribución:
 * el código viaja siempre en `main` y una variable de despliegue decide si
 * existe. Sin la bandera, la opción "Kapso" no aparece en Configuración →
 * WhatsApp, su webhook responde 404 y una conexión Kapso que ya estuviera
 * guardada no puede enviar (falla claro, sin marcar reconexión).
 *
 * La migración se aplica siempre: unas columnas nulas son inertes.
 */

/** Valores que cuentan como "encendida". Cualquier otra cosa, apagada. */
const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseKapsoFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Se lee de `process.env` directo, no por `getEnv()`, igual que
 * `atribucionEnabled()`: preguntar si una feature existe no puede depender de
 * que todo el entorno valide (la ingesta lo consulta).
 */
export function kapsoEnabled(): boolean {
  return parseKapsoFlag(process.env.KAPSO);
}

/** Superficie apagada: 404, no 403 — en esta instancia no existe. */
export function kapsoDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
