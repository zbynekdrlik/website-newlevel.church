import { createAdminClient, readServiceKey } from "../_shared/contact.ts";
import {
  constantTimeEqual,
  verifyWhatsAppSignature,
} from "../_shared/whatsapp_webhook.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const VALID_STATUSES = new Set(["sent", "delivered", "read", "failed"]);

function eventTime(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Date().toISOString();
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function errorDetails(errors: unknown) {
  if (!Array.isArray(errors) || !errors.length) {
    return { code: null, message: null };
  }
  const error = errors[0] as Record<string, unknown>;
  const errorData = error.error_data && typeof error.error_data === "object"
    ? error.error_data as Record<string, unknown>
    : {};
  const code = error.code === undefined || error.code === null
    ? null
    : String(error.code).slice(0, 80);
  const message = [error.title, error.message, errorData.details]
    .filter((part): part is string =>
      typeof part === "string" && Boolean(part.trim())
    )
    .join(" — ")
    .slice(0, 1000);
  return { code, message: message || null };
}

function webhookStatuses(payload: unknown) {
  if (!payload || typeof payload !== "object") return [];
  const entries = (payload as Record<string, unknown>).entry;
  if (!Array.isArray(entries)) return [];

  const statuses: Array<{
    id: string;
    status: string;
    timestamp: string;
    errorCode: string | null;
    errorMessage: string | null;
  }> = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = (entry as Record<string, unknown>).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== "object") continue;
      const messageStatuses = (value as Record<string, unknown>).statuses;
      if (!Array.isArray(messageStatuses)) continue;
      for (const item of messageStatuses) {
        if (!item || typeof item !== "object") continue;
        const status = item as Record<string, unknown>;
        if (
          typeof status.id !== "string" || !status.id.startsWith("wamid.") ||
          typeof status.status !== "string" ||
          !VALID_STATUSES.has(status.status)
        ) continue;
        const errors = errorDetails(status.errors);
        statuses.push({
          id: status.id,
          status: status.status,
          timestamp: eventTime(status.timestamp),
          errorCode: errors.code,
          errorMessage: errors.message,
        });
      }
    }
  }
  return statuses;
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expectedToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN") ?? "";
    if (
      mode === "subscribe" && expectedToken && token && challenge &&
      constantTimeEqual(token, expectedToken)
    ) {
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  if (
    !await verifyWhatsAppSignature(
      rawBody,
      req.headers.get("x-hub-signature-256"),
      Deno.env.get("WHATSAPP_APP_SECRET") ?? "",
    )
  ) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const statuses = webhookStatuses(payload);
  if (!statuses.length) return new Response("EVENT_RECEIVED", { status: 200 });

  const admin = createAdminClient(readServiceKey());
  if (!admin) return new Response("Server is not configured", { status: 500 });

  for (const status of statuses) {
    const { error } = await admin.schema("invitation").rpc(
      "record_whatsapp_delivery",
      {
        p_provider_message_id: status.id,
        p_status: status.status,
        p_status_at: status.timestamp,
        p_error_code: status.errorCode,
        p_error_message: status.errorMessage,
      },
    );
    if (error) {
      return new Response("Could not save delivery status", { status: 500 });
    }
  }

  return new Response("EVENT_RECEIVED", { status: 200 });
});
