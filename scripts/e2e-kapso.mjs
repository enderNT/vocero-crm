/**
 * Self-test E2E de comportamiento — 031 conector Kapso (guion
 * specs/031-conector-kapso/quickstart.md). Conduce la app real contra el mock
 * de Kapso: conectar un número por Kapso, recibir lo que Kapso reenvía
 * (firmado) y responder por su proxy, con los caminos infelices.
 *
 * Uso:
 *   1) app corriendo con WA_MOCK_ENABLED=true, KAPSO=on,
 *      KAPSO_BASE_URL=<app>/api/dev/kapso-mock y BD migrada
 *   2) node --env-file=.env scripts/e2e-kapso.mjs
 *
 * Sale con código 1 si algún check falla.
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";

let cookie = "";
let failures = 0;
let checks = 0;

function ok(name, cond, extra = "") {
  checks++;
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) {
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  }
  let json = null;
  try {
    json = await res.clone().json();
  } catch {}
  return { res, json };
}

/** Espera a que `fn` devuelva algo truthy (la ingesta va en after()). */
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  return last;
}

const stamp = Date.now().toString(36);
const PN = `PN-KAPSO-${stamp}`;
const WABA = `WABA-KAPSO-${stamp}`;
const KEY = "kapso_test_key";
const LEAD = `52155${String(Date.now()).slice(-8)}`;

const inject = (body) =>
  api("/api/dev/kapso-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, from: LEAD, name: "Marina Kapso", ...body }),
  });

async function conversation() {
  const convs = (await api("/api/conversations")).json?.conversations ?? [];
  return convs.find((c) => c.contact?.name === "Marina Kapso");
}

async function messagesOf(convId) {
  return (await api(`/api/conversations/${convId}/messages`)).json?.messages ?? [];
}

async function outbox() {
  return ((await api("/api/dev/wa-mock/outbox")).json?.outbox ?? []).filter(
    (o) => o.phoneNumberId === PN
  );
}

async function main() {
  console.log("== Setup: operador ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    su = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  ok("registro o login del operador", su.res.ok, JSON.stringify(su.json));
  await api("/api/dev/kapso-mock/state", { method: "POST", body: JSON.stringify({ reset: true }) });

  const before = await api("/api/settings/whatsapp");
  ok("la opción Kapso existe (KAPSO=on)", before.json?.kapsoAvailable === true, JSON.stringify(before.json));

  console.log("\n== US1: conectar un número de Kapso ==");
  const bad = await api("/api/settings/whatsapp/test", {
    method: "POST",
    body: JSON.stringify({ source: "kapso", phoneNumberId: PN, token: "kapso_revoked_key" }),
  });
  ok("llave revocada → 422", bad.res.status === 422, String(bad.res.status));
  ok(
    "el mensaje dice que Kapso rechazó la llave",
    /Kapso rechazó la llave/.test(bad.json?.error?.message ?? ""),
    JSON.stringify(bad.json)
  );
  const badSave = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({ source: "kapso", wabaId: WABA, phoneNumberId: PN, token: "kapso_revoked_key" }),
  });
  ok("guardar con llave revocada → no guarda", badSave.res.status === 422, String(badSave.res.status));
  const afterBad = (await api("/api/settings/whatsapp")).json?.connection;
  ok("…y la conexión no es la de Kapso", afterBad?.phoneNumberId !== PN, JSON.stringify(afterBad));

  const test = await api("/api/settings/whatsapp/test", {
    method: "POST",
    body: JSON.stringify({ source: "kapso", phoneNumberId: PN, token: KEY }),
  });
  ok("probar conexión con la llave buena → número", test.res.ok && !!test.json?.displayPhoneNumber, JSON.stringify(test.json));

  const save = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({ source: "kapso", wabaId: WABA, phoneNumberId: PN, token: KEY }),
  });
  ok("guardar por Kapso → 200", save.res.ok, JSON.stringify(save.json));
  ok("el reenvío quedó dado de alta en Kapso", save.json?.webhook?.ok === true, JSON.stringify(save.json?.webhook));
  ok("la respuesta no trae el secreto (alta automática)", !JSON.stringify(save.json).includes("secret"));

  const state = (await api("/api/dev/kapso-mock/state")).json;
  const wh = (state?.webhooks ?? []).filter((w) => w.phoneNumberId === PN);
  ok("un solo webhook kind=meta para el número", wh.length === 1 && wh[0].kind === "meta", JSON.stringify(wh));
  ok("apunta a /api/webhooks/wa-kapso/<token>", /\/api\/webhooks\/wa-kapso\/[^/]+$/.test(wh[0]?.url ?? ""), wh[0]?.url);
  ok("con secreto de firma", wh[0]?.hasSecret === true);

  const conn = (await api("/api/settings/whatsapp")).json?.connection;
  ok("GET: source=kapso", conn?.source === "kapso", JSON.stringify(conn));
  ok("GET: últimos 4 de la llave", conn?.tokenLast4 === KEY.slice(-4));
  ok("GET: webhook registrado", conn?.kapso?.webhookRegistered === true);
  ok("GET: nunca el secreto", !JSON.stringify(conn).toLowerCase().includes("secret"));

  const whInfo = (await api("/api/settings/webhook")).json;
  ok("tarjeta del webhook: proveedor Kapso, sin verify token", whInfo?.provider === "kapso" && whInfo?.verifyToken === null, JSON.stringify(whInfo));

  const again = await api("/api/settings/webhook", { method: "POST" });
  ok("reintentar el alta actualiza (no duplica)", again.res.ok, JSON.stringify(again.json));
  const wh2 = ((await api("/api/dev/kapso-mock/state")).json?.webhooks ?? []).filter((w) => w.phoneNumberId === PN);
  ok("…sigue habiendo un solo webhook", wh2.length === 1, JSON.stringify(wh2));

  console.log("\n== US2: recibir por Kapso ==");
  const sinFirma = await inject({ text: "sin firma", noSignature: true });
  ok("sin firma → la ruta responde 401", sinFirma.json?.statuses?.[0] === 401, JSON.stringify(sinFirma.json?.statuses));
  const malaFirma = await inject({ text: "firma mala", badSignature: true });
  ok("firma inválida → 401", malaFirma.json?.statuses?.[0] === 401, JSON.stringify(malaFirma.json?.statuses));

  const wamid = `wamid.kapso.${stamp}.1`;
  const first = await inject({ text: "hola por Kapso", waMessageId: wamid, duplicate: true });
  ok("entrega firmada → 200 (dos veces)", first.json?.statuses?.every((s) => s === 200), JSON.stringify(first.json?.statuses));
  const conv = await until(conversation);
  ok("la conversación aparece en la bandeja", !!conv);
  const msgs = conv ? await until(async () => {
    const m = await messagesOf(conv.id);
    return m.some((x) => x.text === "hola por Kapso") ? m : null;
  }) : [];
  const ins = (msgs ?? []).filter((m) => m.direction === "in");
  ok("el mensaje aparece", ins.some((m) => m.text === "hola por Kapso"));
  ok("duplicado → un solo mensaje", ins.filter((m) => m.text === "hola por Kapso").length === 1, `in=${ins.length}`);
  ok(
    "los rechazados (sin firma / firma mala) no entraron",
    !ins.some((m) => m.text === "sin firma" || m.text === "firma mala")
  );

  const img = await inject({ media: { type: "image", id: `media-kapso-expira-${stamp}` } });
  ok("imagen entregada", img.json?.delivered === true, JSON.stringify(img.json?.statuses));
  const conImagen = await until(async () => {
    const m = await messagesOf(conv?.id);
    const media = m.find((x) => x.direction === "in" && x.media?.kind === "image")?.media;
    return media?.fetchStatus === "available" ? media : null;
  }, 8000);
  ok(
    "la imagen se descarga por el enlace de Kapso (con reintento tras el enlace vencido)",
    conImagen?.fetchStatus === "available",
    JSON.stringify(conImagen)
  );

  const echo = await inject({ echo: true, text: `respondí desde el teléfono ${stamp}` });
  ok("eco entregado", echo.json?.delivered === true);
  const eco = await until(async () =>
    (await messagesOf(conv?.id)).find((m) => m.direction === "out" && m.text?.includes("respondí desde el teléfono"))
  );
  ok("el eco aparece como saliente manual", !!eco, JSON.stringify(eco));

  const porMeta = await api("/api/dev/wa-mock/inbound", {
    method: "POST",
    body: JSON.stringify({ phoneNumberId: PN, from: LEAD, name: "Marina Kapso", text: "colado por Meta" }),
  });
  ok("evento por la ruta de Meta: la ruta responde", porMeta.res.ok, JSON.stringify(porMeta.json));
  await sleep(1500);
  ok(
    "…pero se descarta (un número Kapso solo recibe por su ruta firmada)",
    !(await messagesOf(conv?.id)).some((m) => m.text === "colado por Meta")
  );

  console.log("\n== US3: responder por Kapso ==");
  // La IA puede contestar sola: se apaga en esta conversación para medir solo lo del operador.
  await api(`/api/conversations/${conv?.id}`, { method: "PATCH", body: JSON.stringify({ aiEnabled: false }) });
  const texto = `respuesta por Kapso ${stamp}`;
  const send = await api(`/api/conversations/${conv?.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: texto }),
  });
  ok("texto enviado", send.res.ok, JSON.stringify(send.json));
  ok(
    "llegó al proxy de Kapso (el mock rechaza Bearer: si llegó, fue con X-API-Key)",
    (await outbox()).some((o) => o.body?.text?.body === texto)
  );

  const form = new FormData();
  form.set("file", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9])], { type: "image/jpeg" }), "local.jpg");
  form.set("caption", `foto ${stamp}`);
  const up = await fetch(`${BASE}/api/conversations/${conv?.id}/messages/media`, {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: form,
  });
  ok("imagen enviada (subida al proxy de Kapso)", up.status === 201, String(up.status));
  ok("…y salió como mensaje de imagen", (await outbox()).some((o) => o.type === "image" && o.body?.image?.caption === `foto ${stamp}`));

  const loc = await api(`/api/conversations/${conv?.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ type: "location", location: { latitude: 19.4, longitude: -99.1, name: "Oficina" } }),
  });
  ok("ubicación enviada", loc.res.ok, JSON.stringify(loc.json));

  const tplName = `kapso_${stamp}`;
  const tpl = await api("/api/templates", {
    method: "POST",
    body: JSON.stringify({ name: tplName, language: "es_MX", category: "UTILITY", body: "Hola {{1}}, seguimos aquí" }),
  });
  ok("plantilla creada por Kapso", tpl.res.ok, JSON.stringify(tpl.json));
  const tpls = (await api("/api/templates")).json;
  ok("la pantalla sabe que la conexión es Kapso (aviso de sincronizar)", tpls?.source === "kapso");
  await api("/api/dev/wa-mock/template-status", {
    method: "POST",
    body: JSON.stringify({ wabaId: WABA, name: tplName, language: "es_MX", event: "APPROVED", notify: false }),
  });
  const sync = await api("/api/templates/sync", { method: "POST" });
  ok("sincronizar por Kapso aprueba la plantilla", sync.json?.updated >= 1, JSON.stringify(sync.json));
  const auto1 = await api("/api/templates/sync?auto=1", { method: "POST" });
  const auto2 = await api("/api/templates/sync?auto=1", { method: "POST" });
  ok("la sincronización automática va una vez por minuto", !auto1.json?.throttled && auto2.json?.throttled === true, `${JSON.stringify(auto1.json)} ${JSON.stringify(auto2.json)}`);
  const tplId = (tpls?.templates ?? []).find((t) => t.name === tplName)?.id;
  const tplSend = await api(`/api/conversations/${conv?.id}/messages/template`, {
    method: "POST",
    body: JSON.stringify({ templateId: tplId, variables: ["Marina"] }),
  });
  ok("plantilla enviada por Kapso", tplSend.res.ok, JSON.stringify(tplSend.json));
  ok("…y llegó como type=template", (await outbox()).some((o) => o.type === "template" && o.body?.template?.name === tplName));

  console.log("\n== US3: caminos infelices ==");
  await api("/api/dev/kapso-mock/state", { method: "POST", body: JSON.stringify({ failNext: 429 }) });
  const limitado = await api(`/api/conversations/${conv?.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: `con 429 ${stamp}` }),
  });
  ok("429 de Kapso → el envío falla", !limitado.res.ok, String(limitado.res.status));
  ok("…como no disponible (reintentable)", limitado.json?.error?.code === "meta_unavailable", JSON.stringify(limitado.json));
  ok("…y la conexión sigue conectada", (await api("/api/settings/whatsapp")).json?.connection?.status === "connected");

  // El dueño revoca la llave en el panel de Kapso.
  await api("/api/dev/kapso-mock/state", { method: "POST", body: JSON.stringify({ keyRevoked: true }) });
  const revocada = await api(`/api/conversations/${conv?.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: `con llave revocada ${stamp}` }),
  });
  ok("llave revocada → reconnect_required", revocada.json?.error?.code === "reconnect_required", JSON.stringify(revocada.json));
  ok(
    "…con un mensaje que habla de Kapso",
    /Kapso rechazó la llave/.test(revocada.json?.error?.message ?? ""),
    revocada.json?.error?.message
  );
  ok("…y la conexión queda en reconnect_required", (await api("/api/settings/whatsapp")).json?.connection?.status === "reconnect_required");
  await api("/api/dev/kapso-mock/state", { method: "POST", body: JSON.stringify({ keyRevoked: false }) });
  const reconecta = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({ source: "kapso", wabaId: WABA, phoneNumberId: PN, token: KEY }),
  });
  ok("reconectar con la llave vigente → conectado otra vez", reconecta.res.ok && (await api("/api/settings/whatsapp")).json?.connection?.status === "connected");

  console.log(`\n===== ${checks - failures}/${checks} checks OK, ${failures} fallos =====`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
