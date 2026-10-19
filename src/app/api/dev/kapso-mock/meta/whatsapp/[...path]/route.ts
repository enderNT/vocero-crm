import { mockGuard } from "@/lib/dev-guard";
import {
  checkKapsoKey,
  getKapsoMockState,
  KAPSO_MOCK_EXPIRED_TOKEN,
  kapsoMockFailure,
  kapsoUnauthorized,
} from "@/server/dev/kapso-mock-state";
import {
  DELETE as graphDelete,
  GET as graphGet,
  POST as graphPost,
} from "@/app/api/dev/wa-mock/graph/[...path]/route";

/**
 * 031 — Imitación del proxy de Kapso para la Cloud API de Meta
 * (`{KAPSO_BASE_URL}/meta/whatsapp/v24.0/…`). Responde lo mismo que el wa-mock
 * de Graph —comparten bandeja de salida y plantillas— salvo en lo que Kapso es
 * distinto: la llave en `X-API-Key` (un `Authorization` se rechaza, para que un
 * test detecte un Bearer), solo `v24.0`, la descarga de adjuntos por
 * `download_url` sin cabeceras y la ausencia de `subscribed_apps` y
 * `webhook_configuration`.
 *
 * Contrato: specs/031-conector-kapso/contracts/mocks.md
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

const VERSION = "v24.0";
/** Bearer con el que se delega al wa-mock (que solo mira sufijos `-invalid`). */
const DELEGATED_TOKEN = "kapso-mock-proxied";

function notFound(): Response {
  return Response.json(
    { error: { message: "Unsupported request", code: 100 } },
    { status: 404 }
  );
}

/** Bytes de un adjunto: la descarga firmada no lleva cabeceras de auth. */
function mediaDownload(req: Request): Response {
  if (req.headers.get("x-api-key") || req.headers.get("authorization")) {
    return Response.json(
      { error: "download_url no lleva cabeceras de autenticación" },
      { status: 400 }
    );
  }
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token || token === KAPSO_MOCK_EXPIRED_TOKEN) {
    return new Response(null, { status: 410 });
  }
  return new Response(Buffer.from("wa-mock-media"), {
    headers: {
      "content-type": token.includes("pdf") ? "application/pdf" : "image/jpeg",
    },
  });
}

/**
 * `GET /{media_id}?phone_number_id=` → metadata con `download_url`. Un id con
 * `-expira` entrega primero un enlace vencido, para probar el reintento.
 */
function mediaMetadata(req: Request, mediaId: string): Response {
  const url = new URL(req.url);
  if (!url.searchParams.get("phone_number_id")) {
    return Response.json(
      { error: { message: "phone_number_id is required", code: 100 } },
      { status: 400 }
    );
  }
  const state = getKapsoMockState();
  const vez = (state.downloads[mediaId] ?? 0) + 1;
  state.downloads[mediaId] = vez;
  const token =
    mediaId.includes("-expira") && vez === 1 ? KAPSO_MOCK_EXPIRED_TOKEN : mediaId;
  const base = `${url.origin}/api/dev/kapso-mock/meta/whatsapp`;
  return Response.json({
    id: mediaId,
    mime_type: mediaId.includes("pdf") ? "application/pdf" : "image/jpeg",
    file_size: "13",
    sha256: "mock",
    // La de Meta: sin token de Meta no sirve (el proxy real la incluye igual).
    url: `${base}/lookaside?mid=${encodeURIComponent(mediaId)}`,
    download_url: `${base}/media_download?token=${encodeURIComponent(token)}`,
    messaging_product: "whatsapp",
  });
}

/** Reenvía al wa-mock de Graph con la misma ruta, query y cuerpo. */
async function delegate(
  handler: (req: Request, ctx: Params) => Promise<Response>,
  req: Request,
  path: string[]
): Promise<Response> {
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await req.arrayBuffer();
  const headers = new Headers({ authorization: `Bearer ${DELEGATED_TOKEN}` });
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const forwarded = new Request(req.url, { method: req.method, headers, body });
  return handler(forwarded, { params: Promise.resolve({ path }) });
}

/** Lo común a todos los métodos: auth, fallos a pedido y versión. */
async function preflight(
  req: Request,
  ctx: Params
): Promise<{ response: Response } | { rest: string[] }> {
  const guard = mockGuard();
  if (guard) return { response: guard };
  const path = (await ctx.params).path;

  if (path[0] === "media_download") return { response: mediaDownload(req) };
  if (path[0] === "lookaside") return { response: new Response(null, { status: 401 }) };

  const auth = checkKapsoKey(req);
  if (auth !== "ok") return { response: kapsoUnauthorized(auth) };
  const failure = kapsoMockFailure(req);
  if (failure) return { response: failure };

  if (path[0] !== VERSION) return { response: notFound() };
  const rest = path.slice(1);
  // El proxy de Kapso no expone la gestión del webhook de Meta.
  if (rest.includes("subscribed_apps")) return { response: notFound() };
  const fields = new URL(req.url).searchParams.get("fields") ?? "";
  if (fields.includes("webhook_configuration")) return { response: notFound() };
  return { rest };
}

export async function GET(req: Request, ctx: Params) {
  const pre = await preflight(req, ctx);
  if ("response" in pre) return pre.response;
  const { rest } = pre;
  if (rest.length === 1 && rest[0]!.startsWith("media")) {
    return mediaMetadata(req, rest[0]!);
  }
  return delegate(graphGet, req, [VERSION, ...rest]);
}

export async function POST(req: Request, ctx: Params) {
  const pre = await preflight(req, ctx);
  if ("response" in pre) return pre.response;
  return delegate(graphPost, req, [VERSION, ...pre.rest]);
}

export async function DELETE(req: Request, ctx: Params) {
  const pre = await preflight(req, ctx);
  if ("response" in pre) return pre.response;
  return delegate(graphDelete, req, [VERSION, ...pre.rest]);
}
