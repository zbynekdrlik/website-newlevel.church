import {
  corsHeaders,
  createAdminClient,
  createUserClient,
  json,
  readPublishableKey,
  readServiceKey,
  validateRequestBasics,
} from "./contact.ts";

const adminEmails = new Set(
  (Deno.env.get("ADMIN_EMAILS") ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

export async function requireAdmin(req: Request): Promise<
  | { ok: false; response: Response }
  | { ok: true; admin: any; user: { id: string; email?: string } }
> {
  if (req.method === "OPTIONS") {
    return {
      ok: false as const,
      response: new Response(null, { status: 204, headers: corsHeaders(req) }),
    };
  }

  const basics = validateRequestBasics(req);
  if (basics.ok === false) {
    return { ok: false, response: basics.response };
  }

  const userClient = createUserClient(
    readPublishableKey(),
    req.headers.get("authorization") ?? "",
  );
  const admin = createAdminClient(readServiceKey());

  if (!userClient || !admin) {
    return {
      ok: false as const,
      response: json(
        req,
        { success: false, error: "Server is not configured" },
        500,
      ),
    };
  }

  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();

  const email = user?.email?.toLowerCase() ?? "";
  if (error || !user || !adminEmails.has(email)) {
    return {
      ok: false as const,
      response: json(req, { success: false, error: "Forbidden" }, 403),
    };
  }

  return { ok: true, admin, user };
}
