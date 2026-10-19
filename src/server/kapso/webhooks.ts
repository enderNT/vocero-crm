import { kapsoBaseUrl } from "@/server/kapso/transport";

/**
 * 031 — Alta del reenvío en Kapso (Platform API, research R8). La misma llave
 * del proyecto autentica: `X-API-Key`. Kapso permite UN webhook `kind: meta`
 * por número (aunque esté inactivo), así que se lista y se actualiza si ya
 * existe; si no, se crea.
 *
 * Todo es best-effort: ninguna función lanza. Si el alta falla, la conexión
 * queda guardada igual y la pantalla ofrece pegar URL y secreto a mano.
 */

export type KapsoWebhook = {
  id: string;
  kind?: string;
  url?: string;
  active?: boolean;
};

export type ResultadoReenvio =
  | { ok: true; webhookId: string }
  | { ok: false; code: string; message: string };

type Llamada = { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown };

class KapsoPlatformError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function platform<T>(apiKey: string, path: string, opts: Llamada = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${kapsoBaseUrl()}/platform/v1/${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "X-API-Key": apiKey,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new KapsoPlatformError("No se pudo contactar a Kapso", 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const err = (json as { error?: unknown; message?: unknown } | null) ?? {};
    const raw = typeof err.error === "string" ? err.error : err.message;
    throw new KapsoPlatformError(
      typeof raw === "string" ? raw : `Kapso respondió ${res.status}`,
      res.status
    );
  }
  return json as T;
}

/** `{ data: … }` o el valor directo: se acepta cualquiera de las dos formas. */
function unwrap<T>(json: unknown): T {
  const data = (json as { data?: unknown } | null)?.data;
  return (data ?? json) as T;
}

const rutaWebhooks = (phoneNumberId: string) =>
  `whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}/webhooks`;

export async function listarWebhooks(
  apiKey: string,
  phoneNumberId: string
): Promise<KapsoWebhook[]> {
  const list = unwrap<KapsoWebhook[]>(await platform(apiKey, rutaWebhooks(phoneNumberId)));
  return Array.isArray(list) ? list : [];
}

export async function crearWebhookMeta(
  apiKey: string,
  phoneNumberId: string,
  url: string,
  secret: string
): Promise<KapsoWebhook> {
  return unwrap<KapsoWebhook>(
    await platform(apiKey, rutaWebhooks(phoneNumberId), {
      method: "POST",
      body: { whatsapp_webhook: { kind: "meta", url, secret_key: secret, active: true } },
    })
  );
}

export async function actualizarWebhook(
  apiKey: string,
  phoneNumberId: string,
  webhookId: string,
  url: string,
  secret: string
): Promise<KapsoWebhook> {
  return unwrap<KapsoWebhook>(
    await platform(apiKey, `${rutaWebhooks(phoneNumberId)}/${encodeURIComponent(webhookId)}`, {
      method: "PATCH",
      body: { whatsapp_webhook: { url, secret_key: secret, active: true } },
    })
  );
}

/** Retira el webhook en Kapso. Best-effort: devuelve si se pudo. */
export async function borrarWebhook(
  apiKey: string,
  phoneNumberId: string,
  webhookId: string
): Promise<boolean> {
  try {
    await platform(apiKey, `${rutaWebhooks(phoneNumberId)}/${encodeURIComponent(webhookId)}`, {
      method: "DELETE",
    });
    return true;
  } catch (err) {
    // Ya no existe: el resultado es el mismo que borrarlo.
    return err instanceof KapsoPlatformError && err.status === 404;
  }
}

/**
 * Deja el reenvío `meta` del número apuntando a esta instancia con el secreto
 * dado. Nunca lanza.
 */
export async function registrarReenvio(input: {
  apiKey: string;
  phoneNumberId: string;
  url: string;
  secret: string;
}): Promise<ResultadoReenvio> {
  const { apiKey, phoneNumberId, url, secret } = input;
  try {
    const existente = (await listarWebhooks(apiKey, phoneNumberId)).find(
      (w) => w.kind === "meta"
    );
    const webhook = existente
      ? await actualizarWebhook(apiKey, phoneNumberId, existente.id, url, secret)
      : await crearWebhookMeta(apiKey, phoneNumberId, url, secret);
    const webhookId = webhook?.id ?? existente?.id;
    if (!webhookId) {
      return { ok: false, code: "kapso_error", message: "Kapso no devolvió el id del webhook" };
    }
    return { ok: true, webhookId };
  } catch (err) {
    const status = err instanceof KapsoPlatformError ? err.status : 0;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 401 || status === 403) {
      return {
        ok: false,
        code: "kapso_sin_permiso",
        message: "Kapso rechazó la llave al dar de alta el webhook",
      };
    }
    if (status === 0 || status === 429 || status >= 500) {
      return {
        ok: false,
        code: "kapso_no_disponible",
        message: "Kapso no está disponible en este momento; reintenta en unos minutos",
      };
    }
    return { ok: false, code: "kapso_error", message };
  }
}
