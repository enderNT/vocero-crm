/**
 * 031 — Estado en memoria del mock de Kapso (solo dev/test). Vive en
 * globalThis porque Next recarga módulos en dev. La bandeja de salida, las
 * plantillas y los adjuntos se comparten con el wa-mock (`getWaMockState`),
 * para que los self-tests lean lo enviado por Kapso con las mismas rutas
 * `/api/dev/wa-mock/outbox`. Aquí solo vive lo propio de Kapso: llaves y
 * webhooks dados de alta por número.
 *
 * Contrato: specs/031-conector-kapso/contracts/mocks.md
 */
import { nextN } from "@/server/dev/wa-mock-state";

/** Llave del proyecto que el mock acepta. */
export const KAPSO_MOCK_KEY = "kapso_test_key";
/** Llave que el mock rechaza con 401 (credencial revocada). */
export const KAPSO_MOCK_REVOKED_KEY = "kapso_revoked_key";
/** Token de descarga que el mock da por vencido (410). */
export const KAPSO_MOCK_EXPIRED_TOKEN = "expired";

export type KapsoMockWebhook = {
  id: string;
  phoneNumberId: string;
  kind: "meta" | "kapso";
  url: string;
  secretKey: string | null;
  active: boolean;
  createdAt: string;
};

type KapsoMockState = {
  webhooks: KapsoMockWebhook[];
  /** Descargas por token: cuántas veces se pidió cada una (para reintentos). */
  downloads: Record<string, number>;
  /**
   * Fallo programado para la próxima llamada al proxy (429 o 503). El envío
   * sale de la app, así que un self-test no puede ponerle la cabecera
   * `x-mock-fail`: lo programa aquí y se consume una vez.
   */
  failNext: 429 | 503 | null;
};

const globalForMock = globalThis as unknown as {
  __kapsoMockState?: KapsoMockState;
};

function freshState(): KapsoMockState {
  return { webhooks: [], downloads: {}, failNext: null };
}

export function getKapsoMockState(): KapsoMockState {
  globalForMock.__kapsoMockState ??= freshState();
  globalForMock.__kapsoMockState.failNext ??= null;
  return globalForMock.__kapsoMockState;
}

export function resetKapsoMockState(): void {
  globalForMock.__kapsoMockState = freshState();
}

export type KapsoKeyCheck = "ok" | "missing" | "revoked" | "bearer";

/**
 * Valida la autenticación de una llamada al mock. `Authorization` presente es
 * un fallo a propósito: así un test detecta si el adaptador mandó Bearer.
 */
export function checkKapsoKey(req: Request): KapsoKeyCheck {
  if (req.headers.get("authorization")) return "bearer";
  const key = req.headers.get("x-api-key") ?? "";
  if (key === KAPSO_MOCK_KEY) return "ok";
  if (key === KAPSO_MOCK_REVOKED_KEY) return "revoked";
  return "missing";
}

/** 401 con la forma de un error de Meta (código 190), como el proxy real. */
export function kapsoUnauthorized(reason: KapsoKeyCheck): Response {
  const message =
    reason === "bearer"
      ? "Kapso mock: llegó Authorization; la llave va en X-API-Key"
      : "Invalid API key";
  return Response.json(
    { error: { message, type: "OAuthException", code: 190 } },
    { status: 401 }
  );
}

/** Camino infeliz a pedido: cabecera `x-mock-fail: 429|503`. */
export function kapsoMockFailure(req: Request): Response | null {
  const state = getKapsoMockState();
  const programado = state.failNext;
  state.failNext = null;
  const fail = req.headers.get("x-mock-fail") ?? (programado ? String(programado) : null);
  if (fail === "429") {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  if (fail === "503") {
    return Response.json(
      { error: { message: "Service unavailable", code: 2 } },
      { status: 503 }
    );
  }
  return null;
}

export function newKapsoWebhookId(): string {
  return `kwh_${nextN()}`;
}
