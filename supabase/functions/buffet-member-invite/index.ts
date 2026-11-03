import {
  createAdminClient,
  createUserClient,
  readPublishableKey,
  readServiceKey,
} from "../_shared/contact.ts";
import { sendEmail } from "../_shared/email.ts";
import { actionLink } from "./auth_links.ts";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 4096;

async function sendAuthEmail(
  email: string,
  subject: string,
  introduction: string,
  link: string,
) {
  const safeLink = link.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return await sendEmail(
    email,
    subject,
    `${introduction}\n\n${link}\n\nOdkaz sa dá použiť iba raz.`,
    `<p>${introduction}</p><p><a href="${safeLink}">Otvoriť Bufet</a></p><p>Odkaz sa dá použiť iba raz.</p>`,
  );
}

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

  const admin = createAdminClient(readServiceKey());
  const publishableKey = readPublishableKey();
  if (!admin || !publishableKey) {
    return json(req, { error: "Služba nie je nakonfigurovaná." }, 500);
  }

  if (body.action === "request-password-reset") {
    const email = typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";
    if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const { data: eligible, error: lookupError } = await admin.rpc(
        "buffet_claim_password_reset",
        { p_email: email },
      );
      if (lookupError) {
        console.error(
          "Buffet password reset membership lookup failed",
          lookupError,
        );
        return json(
          req,
          { error: "Obnovu hesla sa nepodarilo pripraviť." },
          500,
        );
      }
      if (eligible === true) {
        const { data: recovery, error: linkError } = await admin.auth.admin
          .generateLink({
            type: "recovery",
            email,
            options: { redirectTo: origin },
          });
        const link = actionLink(
          recovery?.properties?.action_link,
          "recovery",
          origin,
          Deno.env.get("SUPABASE_URL") ?? "",
        );
        if (
          linkError || !link || recovery?.user.email?.toLowerCase() !== email
        ) {
          console.error("Buffet password recovery link failed", linkError);
        } else {
          const sent = await sendAuthEmail(
            email,
            "Obnova hesla do Bufetu",
            "Požiadali ste o nové heslo do Bufetu. Otvorte odkaz a nastavte si ho.",
            link,
          );
          if (!sent.ok) {
            console.error(
              "Buffet password recovery email failed",
              sent.errorCode,
              sent.errorMessage,
            );
          }
        }
      }
    }
    return json(req, { sent: true });
  }

  if (body.action === "prepare-pwa") {
    const authorization = req.headers.get("authorization") ?? "";
    const accessToken = /^Bearer (\S+)$/i.exec(authorization)?.[1];
    if (!accessToken) {
      return json(req, { error: "Prihlásenie je potrebné." }, 401);
    }

    const { data: authData, error: authError } = await admin.auth.getUser(
      accessToken,
    );
    const user = authData.user;
    if (
      authError || !user?.email ||
      user.user_metadata?.buffet_invitation_account !== true
    ) {
      return json(req, { error: "Prístup nie je povolený." }, 403);
    }

    const userClient = createUserClient(publishableKey, authorization);
    if (!userClient) {
      return json(req, { error: "Služba nie je nakonfigurovaná." }, 500);
    }
    const { data: snapshot, error: snapshotError } = await userClient.rpc(
      "buffet_snapshot",
    );
    if (
      snapshotError || snapshot?.member?.user_id !== user.id ||
      snapshot.member.active !== true
    ) {
      return json(req, { error: "Prístup do Bufetu nie je aktívny." }, 403);
    }

    const { data: link, error: linkError } = await admin.auth.admin
      .generateLink({ type: "magiclink", email: user.email });
    if (
      linkError || link?.user.id !== user.id || !link.properties.hashed_token
    ) {
      console.error("Buffet PWA transfer preparation failed", linkError);
      return json(req, { error: "Prenos prihlásenia sa nepodaril." }, 500);
    }
    return json(req, { tokenHash: link.properties.hashed_token });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const displayName = typeof body.displayName === "string"
    ? body.displayName.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim()
    : "";
  const email = typeof body.email === "string"
    ? body.email.trim().toLowerCase()
    : "";
  if (
    !TOKEN_PATTERN.test(token) || !displayName || displayName.length > 80 ||
    email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return json(req, { error: "Skontrolujte pozvánku, meno a e-mail." }, 400);
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

  const { data: created, error: createError } = await admin.auth.admin
    .generateLink({
      type: "invite",
      email,
      options: {
        redirectTo: origin,
        data: {
          buffet_invitation_account: true,
          buffet_password_setup_pending: true,
        },
      },
    });
  const link = actionLink(
    created?.properties?.action_link,
    "invite",
    origin,
    Deno.env.get("SUPABASE_URL") ?? "",
  );
  if (createError || !created.user || !link) {
    console.error("Buffet invitation user creation failed", createError);
    return json(req, {
      error:
        "Pozvánku sa nepodarilo vytvoriť. Ak už tento e-mail má účet New Level alebo Bufet, prihláste sa e-mailom a heslom. Inak kontaktujte správcu.",
    }, 400);
  }

  const sent = await sendAuthEmail(
    email,
    "Pozvánka do Bufetu",
    "Boli ste pozvaní do Bufetu. Otvorte odkaz, potvrďte svoj e-mail a nastavte si heslo.",
    link,
  );
  if (!sent.ok) {
    console.error(
      "Buffet invitation email failed",
      sent.errorCode,
      sent.errorMessage,
    );
    return json(req, {
      error: "E-mail sa nepodarilo odoslať. Skúste to neskôr.",
    }, 502);
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
    return json(
      req,
      { error: "Pozvánka už bola použitá alebo jej skončila platnosť." },
      400,
    );
  }

  return json(req, { sent: true });
});
