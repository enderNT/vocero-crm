import { apiError, withAuth } from "@/lib/api";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import {
  autoSyncPermitido,
  syncTemplates,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

/**
 * Sincroniza estados de plantillas por Graph API (pull). Vía universal para
 * el modo agencia: los webhooks de plantillas no siguen el override de
 * callback (limitación de Meta documentada en el README).
 */
export const POST = withAuth(async (session, req: Request) => {
  // 031: la sincronización automática de la pantalla (`?auto=1`) con una
  // conexión Kapso va como mucho una vez por minuto.
  if (new URL(req.url).searchParams.get("auto") === "1") {
    const creds = await getCredentialsByOrg(session.organizationId);
    if (creds?.source === "kapso" && !autoSyncPermitido(session.organizationId)) {
      return Response.json({ ok: true, updated: 0, throttled: true });
    }
  }
  try {
    const updated = await syncTemplates(session.organizationId);
    return Response.json({ ok: true, updated });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
});
