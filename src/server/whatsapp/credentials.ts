import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { scoped } from "@/lib/db/tenant";

export type Credentials = {
  id: string;
  organizationId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: "connected" | "reconnect_required";
  /** Token de usuario del sistema de Meta, o llave del proyecto de Kapso. */
  token: string;
  /** 031 — Por dónde habla este número. */
  source: "meta" | "kapso";
  /** 031 — Secreto de firma del reenvío de Kapso (descifrado). */
  webhookSecret: string | null;
  /** 031 — Id del webhook `meta` dado de alta en Kapso. */
  kapsoWebhookId: string | null;
};

export type CredentialSource = Credentials["source"];

type Row = typeof schema.metaCredentials.$inferSelect;

function toCredentials(row: Row): Credentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
    displayPhoneNumber: row.displayPhoneNumber,
    verifiedName: row.verifiedName,
    status: row.status,
    token: decryptSecret({
      cipher: row.tokenCipher,
      iv: row.tokenIv,
      tag: row.tokenTag,
    }),
    source: row.source,
    webhookSecret: decryptWebhookSecret(row),
    kapsoWebhookId: row.kapsoWebhookId,
  };
}

function decryptWebhookSecret(row: Row): string | null {
  if (!row.webhookSecretCipher || !row.webhookSecretIv || !row.webhookSecretTag) {
    return null;
  }
  return decryptSecret({
    cipher: row.webhookSecretCipher,
    iv: row.webhookSecretIv,
    tag: row.webhookSecretTag,
  });
}

/** Resuelve la conexión por phone_number_id (enrutamiento del webhook). */
export async function getCredentialsByPhoneNumberId(
  phoneNumberId: string
): Promise<Credentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.phoneNumberId, phoneNumberId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Resuelve la conexión por WABA ID (eventos a nivel WABA, ej. plantillas). */
export async function getCredentialsByWabaId(
  wabaId: string
): Promise<Credentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.wabaId, wabaId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function getCredentialsByOrg(
  organizationId: string
): Promise<Credentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.metaCredentials)
    .where(scoped(schema.metaCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function saveCredentials(input: {
  organizationId: string;
  wabaId: string;
  phoneNumberId: string;
  token: string;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  /** 031 — Default `meta`. Con `kapso`, `webhookSecret` es obligatorio. */
  source?: CredentialSource;
  webhookSecret?: string | null;
  kapsoWebhookId?: string | null;
}): Promise<void> {
  const source = input.source ?? "meta";
  if (source === "kapso" && !input.webhookSecret) {
    throw new Error("Una conexión Kapso necesita su secreto de firma");
  }
  const db = getDb();
  const enc = encryptSecret(input.token);
  // Con `meta` las columnas de Kapso quedan nulas: pasar de Kapso a Meta con el
  // mismo número limpia el secreto y el id del webhook (data-model.md).
  const secret =
    source === "kapso" && input.webhookSecret
      ? encryptSecret(input.webhookSecret)
      : null;
  const fields = {
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
    displayPhoneNumber: input.displayPhoneNumber ?? null,
    verifiedName: input.verifiedName ?? null,
    tokenCipher: enc.cipher,
    tokenIv: enc.iv,
    tokenTag: enc.tag,
    status: "connected" as const,
    source,
    webhookSecretCipher: secret?.cipher ?? null,
    webhookSecretIv: secret?.iv ?? null,
    webhookSecretTag: secret?.tag ?? null,
    kapsoWebhookId: source === "kapso" ? (input.kapsoWebhookId ?? null) : null,
  };
  await db
    .insert(schema.metaCredentials)
    .values({
      id: newId("credentials"),
      organizationId: input.organizationId,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [schema.metaCredentials.organizationId],
      set: { ...fields, updatedAt: new Date() },
    });
}

/** 031 — Secreto de firma para el reenvío de Kapso: 32 bytes en base64url. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** 031 — Guarda (o borra) el id del webhook dado de alta en Kapso. */
export async function setKapsoWebhookId(
  organizationId: string,
  webhookId: string | null
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.metaCredentials)
    .set({ kapsoWebhookId: webhookId, updatedAt: new Date() })
    .where(scoped(schema.metaCredentials.organizationId, organizationId));
}

/**
 * 031 — Secretos de todas las conexiones Kapso de la instancia, para verificar
 * la firma de un reenvío antes de saber a qué número va (en la práctica, una).
 */
export async function listKapsoWebhookSecrets(): Promise<
  { id: string; phoneNumberId: string; wabaId: string; secret: string }[]
> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.source, "kapso"));
  return rows.flatMap((row) => {
    const secret = decryptWebhookSecret(row);
    return secret
      ? [{ id: row.id, phoneNumberId: row.phoneNumberId, wabaId: row.wabaId, secret }]
      : [];
  });
}

/**
 * Desconectar el número: borra las credenciales cifradas de la organización.
 *
 * No toca conversaciones, contactos ni leads — son de la organización, no de
 * la conexión. Idempotente: sin fila, no hay nada que borrar.
 */
export async function desconectarCanal(organizationId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.metaCredentials)
    .where(scoped(schema.metaCredentials.organizationId, organizationId));
}

/** Marca la conexión como vencida (token inválido detectado en runtime). */
export async function markReconnectRequired(
  organizationId: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.metaCredentials)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(scoped(schema.metaCredentials.organizationId, organizationId));
}

/** Últimos 4 caracteres del token para mostrar en UI (jamás el token). */
export function tokenLast4(token: string): string {
  return token.slice(-4);
}
