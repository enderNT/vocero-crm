import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 031 — El conector Kapso convive con lo que ya existía: una conversación del
 * Laboratorio con una conexión Kapso lanza ANTES de pedir el transporte (el
 * guardarraíl no depende de por dónde hable el número), y una conexión Meta
 * nunca toca la base de Kapso aunque la bandera esté encendida.
 */

const transportFor = vi.fn();

vi.mock("@/server/whatsapp/transport", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/whatsapp/transport")>();
  return { ...original, transportFor };
});

function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy"]) {
    chain[m] = () => chain;
  }
  chain.limit = () => Promise.resolve(rows);
  return chain;
}

const selectRows: unknown[][] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({ select: () => makeChain(selectRows.shift() ?? []) }),
  schema: {
    conversation: { contactId: "contactId", id: "id" },
    contact: { id: "id" },
    message: {},
  },
}));

vi.mock("@/server/whatsapp/credentials", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/whatsapp/credentials")>();
  return {
    ...original,
    getCredentialsByOrg: async () => ({
      id: "cred",
      organizationId: "org_1",
      wabaId: "w",
      phoneNumberId: "pn_kapso",
      displayPhoneNumber: null,
      verifiedName: null,
      status: "connected",
      token: "kapso_llave",
      source: "kapso",
      webhookSecret: "s",
      kapsoWebhookId: "kwh_1",
    }),
  };
});

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-test-suficiente";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
});

beforeEach(() => {
  transportFor.mockReset();
  selectRows.length = 0;
  process.env.KAPSO = "on";
});

afterEach(() => {
  delete process.env.KAPSO;
});

describe("convivencia del conector Kapso", () => {
  it("Laboratorio + conexión Kapso → sandbox_violation sin pedir el transporte", async () => {
    selectRows.push([
      {
        conversation: {
          id: "cv_test",
          organizationId: "org_1",
          isTest: true,
          lastInboundAt: new Date(),
        },
        contact: { id: "ct_1", phone: "5215511111111" },
      },
    ]);
    const { sendText } = await import("@/server/inbox/send");
    await expect(
      sendText({ conversationId: "cv_test", organizationId: "org_1", text: "hola" })
    ).rejects.toMatchObject({ code: "sandbox_violation" });
    expect(transportFor).not.toHaveBeenCalled();
  });
});
