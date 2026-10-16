import { createClient } from "npm:@supabase/supabase-js@2";
import {
  createAdminClient,
  readPublishableKey,
  readServiceKey,
} from "../_shared/contact.ts";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 4096;

function allowedOrigins() {
  return new Set([
    "https://bufet.newlevel.church",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(Deno.env.get("ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ]);
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins().has(origin) ? origin : "",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function deleteUser(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  userId: string,
) {
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) console.error("Failed to clean up Buffet invitation user", error);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const origin = req.headers.get("origin");
  if (req.method !== "POST" || !origin || !allowedOrigins().has(origin)) {
    return json(req, { error: "Forbidden" }, 403);
  }
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return json(req, { error: "Invalid request" }, 415);
  }
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return json(req, { error: "Invalid request" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json(req, { error: "Invalid request" }, 413);
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid body");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json(req, { error: "Invalid request" }, 400);
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const displayName = typeof body.displayName === "string"
    ? body.displayName.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim()
    : "";
  if (!TOKEN_PATTERN.test(token) || !displayName || displayName.length > 80) {
    return json(req, { error: "Pozvánka alebo meno nie sú platné." }, 400);
  }

  const admin = createAdminClient(readServiceKey());
  const publishableKey = readPublishableKey();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!admin || !publishableKey || !supabaseUrl) {
    return json(req, { error: "Služba nie je nakonfigurovaná." }, 500);
  }

  const { data: invitationValid, error: validationError } = await admin.rpc(
    "buffet_member_invitation_is_valid",
    { p_token: token },
  );
  if (validationError) {
    console.error("Buffet invitation validation failed", validationError);
    return json(req, { error: "Pozvánku sa nepodarilo overiť." }, 500);
  }
  if (invitationValid !== true) {
    return json(
      req,
      { error: "Pozvánka už bola použitá alebo jej skončila platnosť." },
      400,
    );
  }

  const identity = crypto.randomUUID();
  const email = `${identity}@members.bufet.newlevel.church`;
  const password = `${crypto.randomUUID()}-${crypto.randomUUID()}-Aa1!`;
  const { data: created, error: createError } = await admin.auth.admin
    .createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { buffet_invitation_account: true },
    });
  if (createError || !created.user) {
    console.error("Buffet invitation user creation failed", createError);
    return json(req, { error: "Účet sa nepodarilo vytvoriť." }, 500);
  }

  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signedIn, error: signInError } = await userClient.auth
    .signInWithPassword({ email, password });
  if (signInError || !signedIn.session) {
    console.error("Buffet invitation sign-in failed", signInError);
    await deleteUser(admin, created.user.id);
    return json(req, { error: "Účet sa nepodarilo prihlásiť." }, 500);
  }

  const { error: redeemError } = await admin.rpc(
    "buffet_redeem_member_invitation",
    {
      p_token: token,
      p_display_name: displayName,
      p_user_id: created.user.id,
    },
  );
  if (redeemError) {
    console.error("Buffet invitation redemption failed", redeemError);
    await deleteUser(admin, created.user.id);
    return json(
      req,
      { error: "Pozvánka už bola použitá alebo jej skončila platnosť." },
      400,
    );
  }

  return json(req, {
    accessToken: signedIn.session.access_token,
    refreshToken: signedIn.session.refresh_token,
  });
});
