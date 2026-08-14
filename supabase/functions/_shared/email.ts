export type EmailSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; errorCode: string; errorMessage: string };

type PartyEmailOptions = {
  preheader?: string;
  ctaUrl?: string;
  ctaLabel?: string;
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
  const ctaLabel = escapeHtml(options.ctaLabel ?? "Potvrdit ucast");

  return `<!doctype html>
<html lang="sk">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeSubject}</title>
  </head>
  <body style="margin:0;background:#0f1117;color:#f8fafc;font-family:Inter,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f1117;padding:28px 14px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#171a23;border:1px solid #2a2f3d;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:26px 26px 18px;background:#10131b;">
                <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#93c5fd;font-weight:700;">New Level Youth</div>
                <h1 style="margin:10px 0 0;font-size:30px;line-height:1.12;color:#ffffff;">${safeSubject}</h1>
                <p style="margin:12px 0 0;color:#cbd5e1;font-size:15px;line-height:1.6;">Každý piatok o 18:00, Letná 31/26, Spišská Nová Ves.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 26px 4px;color:#e5e7eb;font-size:16px;line-height:1.7;">
                ${textToHtml(body)}
              </td>
            </tr>
            <tr>
              <td style="padding:10px 26px 28px;">
                <a href="${ctaUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;font-size:15px;padding:13px 18px;border-radius:12px;">${ctaLabel}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 26px;background:#111827;border-top:1px solid #273244;color:#9ca3af;font-size:13px;line-height:1.55;">
                Jedlo, hry, karaoke a dobra atmosfera. Sleduj nas aj na Instagrame @newlevel_youth.
              </td>
            </tr>
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
  timeoutMs = 15000,
): Promise<EmailSendResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const from = Deno.env.get("EMAIL_FROM")?.trim();
  const recipient = to.trim().toLowerCase();
  const safeSubject = subject.trim();
  const safeText = text.trim();

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
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
