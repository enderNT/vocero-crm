import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 031 — Frontera del conector (Principio II, ADR-001): Kapso vive aislado
 * detrás del transporte. La dirección de su API solo aparece en el adaptador
 * y en el esquema del entorno, y el dominio (bandeja, agente, WhatsApp) no
 * importa nada de `@/server/kapso` salvo el propio transporte.
 */

const SRC = path.resolve(__dirname, "../../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const all = files(SRC);

describe("frontera del conector Kapso", () => {
  it("api.kapso.ai solo aparece en src/server/kapso/ y src/lib/env.ts", () => {
    const fuera = all
      .filter((f) => readFileSync(f, "utf8").includes("api.kapso.ai"))
      .map(rel)
      .filter((f) => !f.startsWith("server/kapso/") && f !== "lib/env.ts");
    expect(fuera).toEqual([]);
  });

  it("bandeja, agente y WhatsApp no importan @/server/kapso (salvo el transporte)", () => {
    const dominio = all.filter((f) =>
      /^(server\/inbox|server\/ai|server\/whatsapp)\//.test(rel(f))
    );
    const cruzan = dominio
      .filter((f) => rel(f) !== "server/whatsapp/transport.ts")
      .filter((f) => /from\s+["']@\/server\/kapso/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(cruzan).toEqual([]);
  });
});
