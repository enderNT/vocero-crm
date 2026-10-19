import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { kapsoEnabled } from "@/server/kapso/flag";
import { testConnection } from "@/server/whatsapp/connect";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // 031: por dónde habla el número. Default Meta (lo de siempre).
  source: z.enum(["meta", "kapso"]).default("meta"),
  phoneNumberId: z.string().trim().min(1),
  token: z.string().trim().min(1),
});

/** Prueba de conexión: valida token↔número, NO guarda (FR-040). */
export const POST = withAuth(async (_session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  if (body.data.source === "kapso" && !kapsoEnabled()) {
    return apiError(404, "kapso_apagado", "El conector Kapso no está encendido en esta instancia");
  }

  const check = await testConnection({
    ...body.data,
    source: body.data.source ?? "meta",
  });
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }
  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
  });
});
