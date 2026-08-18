import { renderPartyEmailHtml, sendEmail } from "./email.ts";
import { sendInfobipSms } from "./infobip.ts";
import { buildRegistrationUrl } from "./registration_url.ts";

type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; errorCode: string; errorMessage: string };

type QueueMessage = {
  id: string;
  automation_id: string;
  contact_id: string;
  channel: "sms" | "whatsapp" | "email";
  recipient: string;
  subject: string | null;
  body: string;
  attempts: number | null;
};

type RegistrationContact = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
};

async function sendWhatsApp(to: string, body: string): Promise<SendResult> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    return {
      ok: false,
      errorCode: "WHATSAPP_NOT_CONFIGURED",
      errorMessage: "whatsapp provider not configured",
    };
  }

  const response = await fetch(
    `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to.replace(/^\+/, ""),
        type: "text",
        text: { preview_url: false, body },
      }),
    },
  );

  const data = await response.json().catch(() => ({}));
  const id = data.messages?.[0]?.id as string | undefined;
  return response.ok ? { ok: true, providerMessageId: id ?? null } : {
    ok: false,
    errorCode: `WHATSAPP_HTTP_${response.status}`,
    errorMessage: String(data.error?.message ?? "whatsapp send failed").slice(
      0,
      180,
    ),
  };
}

type DispatchOptions = {
  automationId?: string;
};

export async function dispatchDueMessages(
  admin: any,
  limit: number,
  options: DispatchOptions = {},
) {
  const safeLimit = Math.max(1, Math.min(Number(limit ?? 20), 50));
  let query = admin
    .schema("invitation")
    .from("message_queue")
    .select(
      "id,automation_id,contact_id,channel,recipient,subject,body,attempts",
    )
    .eq("status", "queued")
    .lte("scheduled_for", new Date().toISOString())
    .order("created_at", { ascending: true });

  if (options.automationId) {
    query = query.eq("automation_id", options.automationId);
  }

  const { data: messages, error } = await query.limit(safeLimit);

  if (error || !messages) {
    return {
      ok: false as const,
      error: "Queue load failed",
      details: error
        ? {
          code: error.code,
          message: String(error.message ?? "unknown").slice(0, 180),
        }
        : null,
    };
  }

  const queueMessages = messages as QueueMessage[];
  const contactIds = [...new Set(queueMessages.map((message) => message.contact_id))];
  const { data: contacts } = contactIds.length
    ? await admin
      .schema("invitation")
      .from("contacts")
      .select("id,name,email,phone")
      .in("id", contactIds)
    : { data: [] };
  const contactsById = new Map<string, RegistrationContact>(
    ((contacts ?? []) as RegistrationContact[]).map((contact) => [
      contact.id,
      contact,
    ]),
  );

  const results = [];
  for (const message of queueMessages) {
    const contact = contactsById.get(message.contact_id) ?? {
      email: message.channel === "email" ? message.recipient : null,
      phone: message.channel === "sms" ? message.recipient : null,
    };
    const registrationUrl = buildRegistrationUrl(contact);
    const renderedBody = message.body.replaceAll(
      "{{registration_url}}",
      registrationUrl,
    );
    const attempts = Number(message.attempts ?? 0) + 1;
    await admin
      .schema("invitation")
      .from("message_queue")
      .update({ status: "processing", attempts })
      .eq("id", message.id)
      .eq("status", "queued");

    const result: SendResult = message.channel === "sms"
      ? await sendInfobipSms(message.recipient, renderedBody)
      : message.channel === "whatsapp"
      ? await sendWhatsApp(message.recipient, renderedBody)
      : await sendEmail(
        message.recipient,
        message.subject ?? "New Level Youth",
        renderedBody,
        renderPartyEmailHtml(
          message.subject ?? "New Level Youth",
          renderedBody,
          { ctaUrl: registrationUrl },
        ),
      );

    const provider = message.channel === "sms"
      ? "infobip"
      : message.channel === "whatsapp"
      ? "meta-whatsapp"
      : "resend";
    const status = result.ok === true ? "sent" : "failed";
    const sentAt = result.ok === true ? new Date().toISOString() : null;
    const errorCode = result.ok === true ? null : result.errorCode;
    const errorMessage = result.ok === true ? null : result.errorMessage;
    const providerMessageId = result.ok === true
      ? result.providerMessageId
      : null;

    await admin
      .schema("invitation")
      .from("message_queue")
      .update({
        status,
        provider,
        provider_message_id: providerMessageId,
        last_error: errorMessage,
        sent_at: sentAt,
      })
      .eq("id", message.id);

    await admin
      .schema("invitation")
      .from("message_logs")
      .insert({
        contact_id: message.contact_id,
        automation_id: message.automation_id,
        channel: message.channel,
        provider,
        status,
        provider_message_id: providerMessageId,
        error_code: errorCode,
        error_message: errorMessage,
        sent_at: sentAt,
        metadata: { queue_id: message.id, attempts },
      });

    results.push({
      id: message.id,
      channel: message.channel,
      ok: result.ok,
      errorCode: result.ok ? null : result.errorCode,
      errorMessage: result.ok ? null : result.errorMessage,
    });
  }

  return {
    ok: true as const,
    processed: results.length,
    results,
  };
}
