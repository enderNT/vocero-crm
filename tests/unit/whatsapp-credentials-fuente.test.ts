import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 031 — La conexión de WhatsApp guarda su fuente (Meta o Kapso). Con Kapso
 * lleva además el secreto con el que Kapso firma el reenvío: cifrado, nunca
 * en claro, y obligatorio. Pasar de Kapso a Meta limpia lo de Kapso.
 */

type Upsert = { values: Record<string, unknown>; set: Record<string, unknown> };
const upserts: Upsert[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => {
          upserts.push({ values, set: opts.set });
          return Promise.resolve();
        },
      }),
    }),
  }),
  schema: {
    metaCredentials: { organizationId: "organization_id", source: "source" },
  },
}));

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-test-suficiente";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
});

beforeEach(() => {
  upserts.length = 0;
});

const base = {
  organizationId: "org_1",
  wabaId: "waba1",
  phoneNumberId: "pn1",
  token: "kapso_llave_del_proyecto_1234",
};

describe("credenciales con fuente (031)", () => {
  it("sin fuente se guarda como Meta, con las columnas de Kapso nulas", async () => {
    const { saveCredentials } = await import("@/server/whatsapp/credentials");
    await saveCredentials(base);
    const { values, set } = upserts[0]!;
    for (const row of [values, set]) {
      expect(row.source).toBe("meta");
      expect(row.webhookSecretCipher).toBeNull();
      expect(row.webhookSecretIv).toBeNull();
      expect(row.webhookSecretTag).toBeNull();
      expect(row.kapsoWebhookId).toBeNull();
    }
  });

  it("Kapso sin secreto de firma → error, y no se guarda nada", async () => {
    const { saveCredentials } = await import("@/server/whatsapp/credentials");
    await expect(saveCredentials({ ...base, source: "kapso" })).rejects.toThrow(
      /secreto/
    );
    expect(upserts).toHaveLength(0);
  });

  it("Kapso guarda el secreto cifrado: la fila no lo contiene en claro", async () => {
    const { saveCredentials, generateWebhookSecret } = await import(
      "@/server/whatsapp/credentials"
    );
    const secret = generateWebhookSecret();
    await saveCredentials({
      ...base,
      source: "kapso",
      webhookSecret: secret,
      kapsoWebhookId: "kwh_1",
    });
    const { values } = upserts[0]!;
    expect(values.source).toBe("kapso");
    expect(values.kapsoWebhookId).toBe("kwh_1");
    const serialized = JSON.stringify(upserts[0]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(base.token);

    const { decryptSecret } = await import("@/lib/crypto");
    expect(
      decryptSecret({
        cipher: values.webhookSecretCipher as string,
        iv: values.webhookSecretIv as string,
        tag: values.webhookSecretTag as string,
      })
    ).toBe(secret);
  });

  it("pasar de Kapso a Meta limpia el secreto y el id del webhook", async () => {
    const { saveCredentials } = await import("@/server/whatsapp/credentials");
    await saveCredentials({
      ...base,
      source: "meta",
      // Aunque llegaran, con Meta no se guardan.
      webhookSecret: "no-se-usa",
      kapsoWebhookId: "kwh_viejo",
    });
    const { set } = upserts[0]!;
    expect(set.source).toBe("meta");
    expect(set.webhookSecretCipher).toBeNull();
    expect(set.kapsoWebhookId).toBeNull();
  });

  it("el secreto generado son 32 bytes en base64url y no se repite", async () => {
    const { generateWebhookSecret } = await import("@/server/whatsapp/credentials");
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});
