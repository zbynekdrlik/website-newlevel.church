import {
  corsHeaders,
  createAdminClient,
  json,
  readJsonBody,
  readServiceKey,
  registerContact,
  validateRequestBasics,
} from "../_shared/contact.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const basics = validateRequestBasics(req);
  if (!basics.ok) return basics.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const admin = createAdminClient(readServiceKey());
  if (!admin) {
    return json(
      req,
      { success: false, error: "Server is not configured" },
      500,
    );
  }

  const result = await registerContact(admin, parsed.data, "register-contact");
  if (result.ok === false) {
    return json(req, { success: false, error: result.error }, result.status);
  }

  return json(req, { success: true });
});
