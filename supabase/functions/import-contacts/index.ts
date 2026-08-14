import {
  ContactInput,
  corsHeaders,
  createAdminClient,
  createUserClient,
  json,
  readImportJsonBody,
  readPublishableKey,
  readServiceKey,
  registerContact,
  validateRequestBasics,
} from "../_shared/contact.ts";

type ImportBody = {
  contacts?: ContactInput[];
  source?: string;
};

const adminEmails = new Set(
  (Deno.env.get("ADMIN_EMAILS") ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const basics = validateRequestBasics(req);
  if (!basics.ok) return basics.response;

  const userClient = createUserClient(
    readPublishableKey(),
    req.headers.get("authorization") ?? "",
  );
  const admin = createAdminClient(readServiceKey());

  if (!userClient || !admin) {
    return json(
      req,
      { success: false, error: "Server is not configured" },
      500,
    );
  }

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  const userEmail = user?.email?.toLowerCase() ?? "";
  if (userError || !user || !adminEmails.has(userEmail)) {
    return json(req, { success: false, error: "Forbidden" }, 403);
  }

  const parsed = await readImportJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const body = parsed.data as ImportBody;
  const contacts = Array.isArray(body.contacts)
    ? body.contacts.slice(0, 1000)
    : [];

  if (!contacts.length) {
    return json(req, { success: false, error: "No contacts provided" }, 400);
  }

  const importSource = typeof body.source === "string"
    ? body.source.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim().slice(
      0,
      80,
    ) ||
      "admin-import"
    : "admin-import";

  let imported = 0;
  const errors: Array<{ row: number; error: string }> = [];

  for (const [index, contact] of contacts.entries()) {
    const result = await registerContact(admin, contact, importSource);
    if (result.ok === false) {
      errors.push({ row: index + 1, error: result.error });
      continue;
    }

    imported += 1;
  }

  return json(req, {
    success: true,
    imported,
    failed: errors.length,
    errors,
  });
});
