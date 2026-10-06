import {
  type EmailAttachment,
  emailImageAttachmentFromBytes,
  renderPartyEmailHtml,
  sendEmail,
} from "./email.ts";
import { sendInfobipSms } from "./infobip.ts";
import { buildRegistrationUrl } from "./registration_url.ts";

type SendResult =
  | {
    ok: true;
    providerMessageId: string | null;
    providerStatus?: string | null;
  }
  | {
    ok: false;
    errorCode: string;
    errorMessage: string;
    debugDetails?: string;
  };

type QueueMessage = {
  id: string;
  automation_id: string;
  contact_id: string;
  channel: "sms" | "whatsapp" | "email";
  recipient: string;
  subject: string | null;
  body: string;
  template_name: string | null;
  template_language: string | null;
  template_parameters: unknown;
  attempts: number | null;
};

type RegistrationContact = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
};

const EMAIL_IMAGE_BUCKET = "email-campaign-images";
const EMAIL_IMAGE_CONTENT_ID = "campaign-image";
type EmailImageAttachmentCache = Map<string, Promise<EmailAttachment | null>>;
type WhatsAppImageUrlCache = Map<string, Promise<string | null>>;

function campaignImagePath(value: unknown) {
  return typeof value === "string" &&
      /^campaign\/[0-9a-f-]{36}\.jpg$/i.test(value)
    ? value
    : null;
}

function emailImagePath(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return campaignImagePath(
    (value as Record<string, unknown>).emailImagePath,
  );
}

function whatsappImagePath(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return campaignImagePath(
    (value as Record<string, unknown>).whatsappHeaderImagePath,
  );
}

function emailCtaEnabled(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  return (value as Record<string, unknown>).emailCtaEnabled !== false;
}

async function sendQueuedEmail(
  admin: any,
  message: QueueMessage,
  subject: string,
  body: string,
  registrationUrl: string,
  attachmentCache: EmailImageAttachmentCache,
): Promise<SendResult> {
  const path = emailImagePath(message.template_parameters);
  let attachment: EmailAttachment | undefined;

  if (path) {
    let attachmentPromise = attachmentCache.get(path);
    if (!attachmentPromise) {
      attachmentPromise = (async () => {
        try {
          const { data, error } = await admin.storage
            .from(EMAIL_IMAGE_BUCKET)
            .download(path);
          if (error || !data) return null;
          return emailImageAttachmentFromBytes(
            new Uint8Array(await data.arrayBuffer()),
          );
        } catch {
          return null;
        }
      })();
      attachmentCache.set(path, attachmentPromise);
    }
    attachment = await attachmentPromise ?? undefined;
    if (!attachment) {
      return {
        ok: false,
        errorCode: "EMAIL_ATTACHMENT_UNAVAILABLE",
        errorMessage: "email image attachment is unavailable or invalid",
      };
    }
  }

  return await sendEmail(
    message.recipient,
    subject,
    body,
    renderPartyEmailHtml(subject, body, {
      ctaUrl: registrationUrl,
      showCta: emailCtaEnabled(message.template_parameters),
      ...(attachment ? { imageContentId: EMAIL_IMAGE_CONTENT_ID } : {}),
    }),
    {
      idempotencyKey: `message-queue/${message.id}`,
      ...(attachment ? { attachments: [attachment] } : {}),
    },
  );
}

export function dedupeMessageRecipients<
  T extends { channel: string; recipient: string },
>(rows: T[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.channel}:${row.recipient.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanTemplateParameters(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 1024));
}

function whatsappBodyParameters(value: unknown) {
  if (Array.isArray(value)) return cleanTemplateParameters(value);
  if (!value || typeof value !== "object") return [];
  return cleanTemplateParameters(
    (value as Record<string, unknown>).bodyParameters,
  );
}

function isSingleBodyParameterMismatch(code: unknown, details: string) {
  return Number(code) === 132000 &&
    /body:\s*number of localizable_params\s*\(2\)\s*does not match the expected number of params\s*\(1\)/i
      .test(details);
}

function isMissingImageHeader(code: unknown, details: string) {
  return Number(code) === 132012 &&
    /header:\s*format mismatch,\s*expected image,\s*received unknown/i
      .test(details);
}

async function createWhatsAppImageUrl(
  admin: any,
  path: string,
  cache: WhatsAppImageUrlCache,
) {
  let imageUrl = cache.get(path);
  if (!imageUrl) {
    imageUrl = (async () => {
      try {
        const { data, error } = await admin.storage
          .from(EMAIL_IMAGE_BUCKET)
          .createSignedUrl(path, 3600);
        return error || !data?.signedUrl ? null : data.signedUrl;
      } catch {
        return null;
      }
    })();
    cache.set(path, imageUrl);
  }
  const result = await imageUrl;
  if (!result) cache.delete(path);
  return result;
}

async function sendWhatsApp(
  admin: any,
  to: string,
  body: string,
  imageUrlCache: WhatsAppImageUrlCache,
  options: {
    templateName?: string | null;
    templateLanguage?: string | null;
    templateParameters?: unknown;
  } = {},
): Promise<SendResult> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    return {
      ok: false,
      errorCode: "WHATSAPP_NOT_CONFIGURED",
      errorMessage: "whatsapp provider not configured",
    };
  }

  const templateName = options.templateName?.trim() ?? "";
  const templateLanguage = options.templateLanguage?.trim() || "sk";
  const templateParameters = whatsappBodyParameters(
    options.templateParameters,
  );
  const headerImagePath = whatsappImagePath(options.templateParameters);
  const buildTemplatePayload = (
    bodyParameters: string[],
    headerImageUrl: string | null,
  ) => {
    const components = [
      ...(headerImageUrl
        ? [{
          type: "header",
          parameters: [{
            type: "image",
            image: { link: headerImageUrl },
          }],
        }]
        : []),
      ...(bodyParameters.length
        ? [{
          type: "body",
          parameters: bodyParameters.map((text) => ({ type: "text", text })),
        }]
        : []),
    ];
    return {
      messaging_product: "whatsapp",
      to: to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLanguage },
        ...(components.length ? { components } : {}),
      },
    };
  };
  const messagePayload = templateName
    ? buildTemplatePayload(templateParameters, null)
    : {
      messaging_product: "whatsapp",
      to: to.replace(/^\+/, ""),
      type: "text",
      text: { preview_url: false, body },
    };

  const sendPayload = async (payload: unknown) => {
    const response = await fetch(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  let { response, data } = await sendPayload(messagePayload);
  let bodyParameters = templateParameters;
  let headerImageUrl: string | null = null;
  let bodyParametersReduced = false;

  for (let retry = 0; retry < 2 && !response.ok; retry += 1) {
    const providerMessage = typeof data.error?.message === "string"
      ? data.error.message
      : "";
    const providerDetails = typeof data.error?.error_data?.details === "string"
      ? data.error.error_data.details
      : "";
    const mismatchDetails = `${providerMessage} ${providerDetails}`;

    if (
      templateName && !headerImageUrl && headerImagePath &&
      isMissingImageHeader(data.error?.code, mismatchDetails)
    ) {
      headerImageUrl = await createWhatsAppImageUrl(
        admin,
        headerImagePath,
        imageUrlCache,
      );
      if (!headerImageUrl) {
        return {
          ok: false,
          errorCode: "WHATSAPP_IMAGE_UNAVAILABLE",
          errorMessage: "Fotografiu sa nepodarilo načítať pre WhatsApp.",
        };
      }
    } else if (
      templateName && !bodyParametersReduced && bodyParameters.length === 2 &&
      isSingleBodyParameterMismatch(data.error?.code, mismatchDetails)
    ) {
      bodyParameters = bodyParameters.slice(0, 1);
      bodyParametersReduced = true;
    } else {
      break;
    }

    ({ response, data } = await sendPayload(
      buildTemplatePayload(bodyParameters, headerImageUrl),
    ));
  }

  const id = data.messages?.[0]?.id as string | undefined;
  const finalProviderMessage = typeof data.error?.message === "string"
    ? data.error.message
    : "whatsapp send failed";
  const finalProviderDetails =
    typeof data.error?.error_data?.details === "string"
      ? data.error.error_data.details
      : "";
  const errorMessage = finalProviderDetails
    ? `${finalProviderMessage}: ${finalProviderDetails}`
    : finalProviderMessage;
  if (
    !response.ok && isMissingImageHeader(data.error?.code, errorMessage)
  ) {
    return {
      ok: false,
      errorCode: "WHATSAPP_IMAGE_REQUIRED",
      errorMessage:
        "Táto WhatsApp šablóna vyžaduje fotografiu v hlavičke. Vyber fotografiu a skús odoslanie znova.",
    };
  }
  return response.ok ? { ok: true, providerMessageId: id ?? null } : {
    ok: false,
    errorCode: `WHATSAPP_HTTP_${response.status}`,
    errorMessage: errorMessage.slice(0, 280),
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
  const { data: messages, error } = await admin
    .schema("invitation")
    .rpc("claim_due_messages", {
      p_limit: safeLimit,
      p_automation_id: options.automationId ?? null,
    });

  if (error || !messages) {
    return {
      ok: false as const,
      error: "Queue claim failed",
      details: error
        ? {
          code: error.code,
          message: String(error.message ?? "unknown").slice(0, 180),
        }
        : null,
    };
  }

  const queueMessages = messages as QueueMessage[];
  const contactIds = [
    ...new Set(queueMessages.map((message) => message.contact_id)),
  ];
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
  const emailImageAttachmentCache: EmailImageAttachmentCache = new Map();
  const whatsappImageUrlCache: WhatsAppImageUrlCache = new Map();
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
    const attempts = Number(message.attempts ?? 0);

    const result: SendResult = message.channel === "sms"
      ? await sendInfobipSms(message.recipient, renderedBody, {
        sender: message.template_name,
      })
      : message.channel === "whatsapp"
      ? await sendWhatsApp(
        admin,
        message.recipient,
        renderedBody,
        whatsappImageUrlCache,
        {
          templateName: message.template_name,
          templateLanguage: message.template_language,
          templateParameters: message.template_parameters,
        },
      )
      : await sendQueuedEmail(
        admin,
        message,
        message.subject ?? "New Level Youth",
        renderedBody,
        registrationUrl,
        emailImageAttachmentCache,
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
    const debugDetails = result.ok === true
      ? null
      : result.debugDetails ?? null;
    const providerMessageId = result.ok === true
      ? result.providerMessageId
      : null;
    const providerStatus = result.ok === true
      ? result.providerStatus ?? null
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
        metadata: {
          queue_id: message.id,
          attempts,
          debug_details: debugDetails,
          provider_status: providerStatus,
        },
      });

    results.push({
      id: message.id,
      channel: message.channel,
      ok: result.ok,
      providerMessageId,
      providerStatus,
      errorCode: result.ok ? null : result.errorCode,
      errorMessage: result.ok ? null : result.errorMessage,
      debugDetails,
    });
  }

  return {
    ok: true as const,
    processed: results.length,
    results,
  };
}
