import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 031 — Transporte de WhatsApp por Kapso, contra un `fetch` falso: la llave va
 * en `X-API-Key` (nunca `Authorization`), la ruta es la del proxy con su
 * versión, la descarga usa el enlace firmado sin cabeceras y se reintenta una
 * vez con un enlace nuevo, y los errores se traducen igual que con Meta.
 */

type Call = { url: string; init: RequestInit | undefined };
const calls: Call[] = [];
let responder: (url: string, init?: RequestInit) => Response;

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-test-suficiente";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
  process.env.KAPSO_BASE_URL = "https://kapso.test";
});

beforeEach(() => {
  calls.length = 0;
  process.env.KAPSO = "on";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return responder(url, init);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.KAPSO;
});

const creds = {
  phoneNumberId: "pn_kapso",
  token: "kapso_llave",
  source: "kapso" as const,
};

function headersOf(call: Call): Record<string, string> {
  return Object.fromEntries(
    Object.entries((call.init?.headers ?? {}) as Record<string, string>).map(
      ([k, v]) => [k.toLowerCase(), v]
    )
  );
}

async function transporte() {
  const { transportFor } = await import("@/server/whatsapp/transport");
  return transportFor(creds);
}

describe("transporte Kapso", () => {
  it("usa X-API-Key y nunca Authorization, en la ruta del proxy v24.0", async () => {
    responder = () => Response.json({ messages: [{ id: "wamid.1" }] });
    const t = await transporte();
    await t.request("pn_kapso/messages", { method: "POST", body: { a: 1 } });
    const call = calls[0]!;
    expect(call.url).toBe("https://kapso.test/meta/whatsapp/v24.0/pn_kapso/messages");
    const h = headersOf(call);
    expect(h["x-api-key"]).toBe("kapso_llave");
    expect(h.authorization).toBeUndefined();
  });

  it("la subida multipart va al proxy con X-API-Key", async () => {
    responder = () => Response.json({ id: "media-up-1" });
    const t = await transporte();
    const id = await t.uploadMedia({ data: Buffer.from("x"), mimeType: "image/jpeg" });
    expect(id).toBe("media-up-1");
    expect(calls[0]!.url).toBe("https://kapso.test/meta/whatsapp/v24.0/pn_kapso/media");
    expect(headersOf(calls[0]!)["x-api-key"]).toBe("kapso_llave");
    expect(headersOf(calls[0]!).authorization).toBeUndefined();
  });

  it("descarga: metadata con phone_number_id y bytes del enlace firmado SIN cabeceras", async () => {
    responder = (url) =>
      url.includes("/media_download")
        ? new Response("bytes", { headers: { "content-type": "image/jpeg" } })
        : Response.json({
            mime_type: "image/jpeg",
            file_size: "5",
            download_url: "https://kapso.test/dl/media_download?token=abc",
          });
    const t = await transporte();
    const res = await t.downloadMedia("media1", 1000);
    expect(res.data.toString()).toBe("bytes");
    expect(res.mimeType).toBe("image/jpeg");
    expect(calls[0]!.url).toBe(
      "https://kapso.test/meta/whatsapp/v24.0/media1?phone_number_id=pn_kapso"
    );
    const descarga = headersOf(calls[1]!);
    expect(descarga["x-api-key"]).toBeUndefined();
    expect(descarga.authorization).toBeUndefined();
  });

  it("el tamaño declarado como cadena se respeta", async () => {
    responder = () =>
      Response.json({ file_size: "5000", download_url: "https://kapso.test/x" });
    const t = await transporte();
    await expect(t.downloadMedia("media1", 1000)).rejects.toThrow(/límite/);
    expect(calls).toHaveLength(1); // no llegó a descargar
  });

  it("enlace vencido (410) → pide metadata otra vez y reintenta UNA vez", async () => {
    let metas = 0;
    responder = (url) => {
      if (url.includes("/media_download")) {
        return url.includes("token=viejo")
          ? new Response(null, { status: 410 })
          : new Response("ok");
      }
      metas += 1;
      return Response.json({
        download_url: `https://kapso.test/media_download?token=${metas === 1 ? "viejo" : "nuevo"}`,
      });
    };
    const t = await transporte();
    const res = await t.downloadMedia("media1", 1000);
    expect(res.data.toString()).toBe("ok");
    expect(metas).toBe(2);
  });

  it("si el enlace nuevo también falla, no reintenta más", async () => {
    responder = (url) =>
      url.includes("/media_download")
        ? new Response(null, { status: 403 })
        : Response.json({ download_url: "https://kapso.test/media_download?token=t" });
    const t = await transporte();
    await expect(t.downloadMedia("media1", 1000)).rejects.toThrow(/403/);
    expect(calls).toHaveLength(4); // meta, descarga, meta, descarga
  });

  it("401 / código 190 → error de autenticación", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    responder = () =>
      Response.json(
        { error: { message: "Invalid API key", type: "OAuthException", code: 190 } },
        { status: 401 }
      );
    const t = await transporte();
    const err = await t.request("pn_kapso").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as InstanceType<typeof MetaApiError>).isAuthError).toBe(true);
  });

  it("429 y 503 no son de autenticación (no piden reconectar)", async () => {
    const { MetaApiError } = await import("@/lib/meta/client");
    for (const res of [
      () => Response.json({ error: "Rate limit exceeded" }, { status: 429 }),
      () => Response.json({ error: { message: "down", code: 2 } }, { status: 503 }),
    ]) {
      responder = res;
      const t = await transporte();
      const err = (await t.request("pn_kapso").catch((e: unknown) => e)) as InstanceType<
        typeof MetaApiError
      >;
      expect(err).toBeInstanceOf(MetaApiError);
      expect(err.isAuthError).toBe(false);
    }
  });

  it("con la bandera apagada, transportFor falla claro y sin tocar la red", async () => {
    delete process.env.KAPSO;
    const { transportFor } = await import("@/server/whatsapp/transport");
    expect(() => transportFor(creds)).toThrow(/apagado/);
    expect(calls).toHaveLength(0);
  });

  it("una conexión Meta nunca usa la base de Kapso", async () => {
    responder = () => Response.json({ ok: true });
    const { transportFor } = await import("@/server/whatsapp/transport");
    await transportFor({ ...creds, source: "meta" }).request("pn1");
    expect(calls[0]!.url).not.toContain("kapso.test");
    expect(headersOf(calls[0]!).authorization).toBe("Bearer kapso_llave");
  });
});
