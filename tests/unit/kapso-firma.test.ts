import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

/**
 * 031 — Firma del reenvío de Kapso: HMAC-SHA256 del cuerpo crudo en hex
 * minúscula, sin prefijo. Solo autoriza los números cuyo secreto firmó.
 */

const conexiones: { id: string; phoneNumberId: string; wabaId: string; secret: string }[] = [];

vi.mock("@/server/whatsapp/credentials", () => ({
  listKapsoWebhookSecrets: async () => conexiones,
}));

const cuerpo = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
const firmar = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

beforeEach(() => {
  conexiones.length = 0;
  conexiones.push({ id: "c1", phoneNumberId: "pn1", wabaId: "w1", secret: "secreto-uno" });
});

describe("verificarFirmaKapso", () => {
  it("firma correcta → autoriza su número", async () => {
    const { verificarFirmaKapso } = await import("@/server/kapso/firma");
    const ok = await verificarFirmaKapso(cuerpo, firmar(cuerpo, "secreto-uno"));
    expect([...ok]).toEqual(["pn1"]);
  });

  it("con prefijo sha256= (estilo Meta) → rechazada", async () => {
    const { verificarFirmaKapso } = await import("@/server/kapso/firma");
    const header = `sha256=${firmar(cuerpo, "secreto-uno")}`;
    expect((await verificarFirmaKapso(cuerpo, header)).size).toBe(0);
  });

  it("mayúsculas, longitud incorrecta o sin cabecera → rechazada", async () => {
    const { verificarFirmaKapso } = await import("@/server/kapso/firma");
    const buena = firmar(cuerpo, "secreto-uno");
    for (const header of [buena.toUpperCase(), buena.slice(2), `${buena}00`, "", null]) {
      expect((await verificarFirmaKapso(cuerpo, header)).size).toBe(0);
    }
  });

  it("cuerpo alterado → rechazada", async () => {
    const { verificarFirmaKapso } = await import("@/server/kapso/firma");
    const header = firmar(cuerpo, "secreto-uno");
    expect((await verificarFirmaKapso(`${cuerpo} `, header)).size).toBe(0);
  });

  it("sin conexiones Kapso → nada autorizado", async () => {
    conexiones.length = 0;
    const { verificarFirmaKapso } = await import("@/server/kapso/firma");
    expect((await verificarFirmaKapso(cuerpo, firmar(cuerpo, "secreto-uno"))).size).toBe(0);
  });

  it("dos conexiones: solo autoriza la que coincide", async () => {
    conexiones.push({ id: "c2", phoneNumberId: "pn2", wabaId: "w2", secret: "secreto-dos" });
    const { verificarFirmaKapso } = await import("@/server/kapso/firma");
    const ok = await verificarFirmaKapso(cuerpo, firmar(cuerpo, "secreto-dos"));
    expect([...ok]).toEqual(["pn2"]);
  });
});
