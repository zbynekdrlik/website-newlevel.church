export type EmailSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; errorCode: string; errorMessage: string };

type PartyEmailOptions = {
  preheader?: string;
  ctaUrl?: string;
  ctaLabel?: string;
  showCta?: boolean;
  imageUrl?: string;
};

export const MAX_CAMPAIGN_IMAGE_BYTES = 900_000;
export const EMAIL_IMAGE_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export function isValidCampaignImage(bytes: Uint8Array) {
  return bytes.length > 0 && bytes.length <= MAX_CAMPAIGN_IMAGE_BYTES &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

type EmailSendOptions = {
  idempotencyKey?: string;
  timeoutMs?: number;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function textToHtml(value: string) {
  return escapeHtml(value)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function renderPartyEmailHtml(
  subject: string,
  body: string,
  options: PartyEmailOptions = {},
) {
  const safeSubject = escapeHtml(subject);
  const preheader = escapeHtml(
    options.preheader ?? "New Level Youth pozvanka na tento piatok.",
  );
  const ctaUrl = escapeHtml(
    options.ctaUrl ?? "https://www.newlevel.church/youth/",
  );
  const ctaLabel = escapeHtml(options.ctaLabel ?? "Potvrdiť účasť");
  const ctaButton = options.showCta === false
    ? ""
    : `<p style="margin:24px 0 0;font-size:16px;line-height:1.5;">
              <a href="${ctaUrl}" style="color:#1d4ed8;text-decoration:underline;">${ctaLabel}</a>
            </p>`;
  const imageUrl = options.imageUrl ? escapeHtml(options.imageUrl) : "";
  const inlineImage = imageUrl
    ? `<p style="margin:24px 0 0;">
              <img src="${imageUrl}" alt="Fotografia k pozvánke" width="568" style="display:block;width:100%;max-width:568px;height:auto;border:0;">
            </p>`
    : "";

  return `<!doctype html>
<html lang="sk">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeSubject}</title>
  </head>
  <body style="margin:0;background:#ffffff;color:#1f2937;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td align="center" style="padding:24px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;">
            <tr><td style="padding:0 0 18px;color:#4b5563;font-size:14px;font-weight:700;">New Level Youth</td></tr>
            <tr><td style="color:#1f2937;font-size:16px;line-height:1.6;">${
    textToHtml(body)
  }${inlineImage}${ctaButton}</td></tr>
            <tr><td style="padding-top:28px;color:#6b7280;font-size:13px;line-height:1.5;">New Level Church · Spišská Nová Ves</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html?: string,
  options: EmailSendOptions = {},
): Promise<EmailSendResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const from = Deno.env.get("EMAIL_FROM")?.trim();
  const recipient = to.trim().toLowerCase();
  const safeSubject = subject.trim();
  const safeText = text.trim();
  const idempotencyKey = options.idempotencyKey?.trim() ?? "";
  const timeoutMs = options.timeoutMs ?? 15000;

  if (!apiKey || !from) {
    return {
      ok: false,
      errorCode: "EMAIL_NOT_CONFIGURED",
      errorMessage: "email provider not configured",
    };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return {
      ok: false,
      errorCode: "INVALID_EMAIL",
      errorMessage: "recipient email is invalid",
    };
  }

  if (!safeSubject || safeSubject.length > 180) {
    return {
      ok: false,
      errorCode: "INVALID_SUBJECT",
      errorMessage: "email subject is invalid",
    };
  }

  if (!safeText || safeText.length > 5000) {
    return {
      ok: false,
      errorCode: "INVALID_BODY",
      errorMessage: "email body is invalid",
    };
  }

  if (idempotencyKey && idempotencyKey.length > 256) {
    return {
      ok: false,
      errorCode: "INVALID_IDEMPOTENCY_KEY",
      errorMessage: "email idempotency key is invalid",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: safeSubject,
        text: safeText,
        html: html ?? renderPartyEmailHtml(safeSubject, safeText),
      }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      return {
        ok: true,
        providerMessageId: typeof data.id === "string" ? data.id : null,
      };
    }

    const providerMessage = typeof data.message === "string"
      ? data.message
      : "email send failed";
    return {
      ok: false,
      errorCode: `EMAIL_HTTP_${response.status}`,
      errorMessage: providerMessage.slice(0, 180),
    };
  } catch (error) {
    const isAbort = error instanceof DOMException &&
      error.name === "AbortError";
    return {
      ok: false,
      errorCode: isAbort ? "EMAIL_TIMEOUT" : "EMAIL_NETWORK_ERROR",
      errorMessage: isAbort ? "email provider timeout" : "email send failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}
