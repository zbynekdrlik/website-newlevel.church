import { json, readJsonBody } from "../_shared/contact.ts";
import { requireAdmin } from "../_shared/admin.ts";
import { renderPartyEmailHtml, sendEmail } from "../_shared/email.ts";

Deno.serve(async (req) => {
  const auth = await requireAdmin(req);
  if (auth.ok === false) return auth.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const to = typeof parsed.data.to === "string"
    ? parsed.data.to.trim().toLowerCase()
    : "";
  const subject = typeof parsed.data.subject === "string"
    ? parsed.data.subject.trim()
    : "Prides tento piatok na New Level Youth?";
  const body = typeof parsed.data.body === "string"
    ? parsed.data.body.trim()
    : "Ahoj, tento piatok je New Level Youth. Bude jedlo, hry, karaoke a dobra atmosfera. Das nam prosim vediet, ci prides?";

  const result = await sendEmail(
    to,
    subject,
    body,
    renderPartyEmailHtml(subject, body),
  );

  const didSend = result.ok === true;
  return json(req, {
    success: didSend,
    status: didSend ? "sent" : "failed",
    provider: "resend",
    providerMessageId: didSend ? result.providerMessageId : null,
    errorCode: didSend ? null : result.errorCode,
    errorMessage: didSend ? null : result.errorMessage,
  }, didSend ? 200 : 502);
});
