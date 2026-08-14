import { json, readJsonBody } from "../_shared/contact.ts";
import { requireAdmin } from "../_shared/admin.ts";
import { sendTextBeeSms } from "../_shared/textbee.ts";

Deno.serve(async (req) => {
  const auth = await requireAdmin(req);
  if (auth.ok === false) return auth.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const to = typeof parsed.data.to === "string" ? parsed.data.to.trim() : "";
  const message = typeof parsed.data.message === "string"
    ? parsed.data.message.trim()
    : "";

  const result = await sendTextBeeSms(to, message);
  const didSend = result.ok === true;
  return json(req, {
    success: didSend,
    status: result.status,
    provider: "textbee",
    providerMessageId: didSend ? result.providerMessageId : null,
    errorCode: didSend ? null : result.errorCode,
    errorMessage: didSend ? null : result.errorMessage,
  }, didSend ? 200 : 502);
});
