import {
  corsHeaders,
  createAdminClient,
  json,
  readJsonBody,
  readServiceKey,
  validateRequestBasics,
} from "../_shared/contact.ts";
import { dispatchPartyDiscordNotifications } from "../_shared/party_discord.ts";
import { renderPartyEmailHtml, sendEmail } from "../_shared/email.ts";
import {
  createCancellationToken,
  readCancellationToken,
} from "./cancellation.ts";

function nextFridayDate() {
  const now = new Date();
  const bratislava = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Bratislava" }),
  );
  const day = bratislava.getDay();
  let daysUntilFriday = (5 - day + 7) % 7;
  // A registration made on Friday still belongs to that day's party.
  if (day === 6) daysUntilFriday = 6;
  bratislava.setDate(bratislava.getDate() + daysUntilFriday);
  return bratislava.toISOString().slice(0, 10);
}

function boolish(value: unknown) {
  return value === true ||
    ["ano", "áno", "true", "on", "1", "yes"].includes(
      String(value ?? "").trim().toLowerCase(),
    );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const admin = createAdminClient(readServiceKey());
  if (!admin) {
    return json(
      req,
      { success: false, error: "Server is not configured" },
      500,
    );
  }

  if (req.method === "GET") {
    const requestedDate = new URL(req.url).searchParams.get("eventDate");
    const eventDate = requestedDate || nextFridayDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json(req, { success: false, error: "Invalid eventDate" }, 400);
    }

    const { data, error } = await (admin as any).rpc(
      "get_party_food_registration_count",
      { p_event_date: eventDate },
    );
    if (error) {
      return json(req, { success: false, error: "Count failed" }, 500);
    }

    const count = Number(data);
    return json(req, {
      success: true,
      eventDate,
      count: Number.isFinite(count) ? count : 0,
    });
  }

  const basics = validateRequestBasics(req);
  if (!basics.ok) return basics.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const body = parsed.data;
  if (body.action === "request-cancellation") {
    const email = typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";
    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return json(req, { success: false, error: "Invalid email" }, 400);
    }
    if (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("EMAIL_FROM")) {
      return json(req, { success: false, error: "Email is unavailable" }, 503);
    }

    const eventDate = nextFridayDate();
    const contact = await admin.schema("invitation").from("contacts")
      .select("id").eq("email", email).maybeSingle();
    if (contact.error) {
      console.error("Party cancellation lookup failed", contact.error.code);
      return json(
        req,
        { success: false, error: "Cancellation request failed" },
        500,
      );
    }
    if (contact.data) {
      const event = await admin.schema("invitation").from("party_events")
        .select("id").eq("event_date", eventDate).maybeSingle();
      if (event.error) {
        console.error(
          "Party cancellation event lookup failed",
          event.error.code,
        );
        return json(req, {
          success: false,
          error: "Cancellation request failed",
        }, 500);
      }
      if (event.data) {
        const registration = await admin.schema("invitation")
          .from("party_registrations").select("id,registered_at")
          .eq("event_id", event.data.id)
          .eq("contact_id", contact.data.id).maybeSingle();
        if (registration.error) {
          console.error(
            "Party cancellation registration lookup failed",
            registration.error.code,
          );
          return json(req, {
            success: false,
            error: "Cancellation request failed",
          }, 500);
        }
        if (registration.data) {
          const token = await createCancellationToken({
            registrationId: registration.data.id,
            registeredAt: registration.data.registered_at,
            eventDate,
          }, readServiceKey());
          const url =
            `https://newlevel.church/youth/#registracia?cancel=${token}`;
          const subject = "Odhlásenie z New Level Youth";
          const message =
            "Ak sa chceš odhlásiť z piatkovej Youth, otvor tento odkaz a potvrď odhlásenie. Odkaz platí 1 hodinu. Ak si o odhlásenie nepožiadal(a), tento e-mail ignoruj.";
          const sent = await sendEmail(
            email,
            subject,
            `${message}\n\n${url}`,
            renderPartyEmailHtml(subject, message, {
              ctaUrl: url,
              ctaLabel: "Potvrdiť odhlásenie",
              preheader: "Odkaz na odhlásenie z Youth",
            }),
            { timeoutMs: 10000 },
          );
          if (!sent.ok) {
            console.error("Party cancellation email failed", sent.errorCode);
          }
        }
      }
    }
    // The response does not reveal whether an address is registered.
    return json(req, { success: true });
  }

  if (body.action === "cancel") {
    const token = typeof body.token === "string" ? body.token : "";
    const claim = await readCancellationToken(token, readServiceKey());
    if (!claim) {
      return json(
        req,
        { success: false, error: "Invalid or expired link" },
        410,
      );
    }
    const deleted = await admin.schema("invitation")
      .from("party_registrations").delete()
      .eq("id", claim.registrationId)
      .eq("registered_at", claim.registeredAt)
      .select("id").maybeSingle();
    if (deleted.error) {
      console.error("Party cancellation delete failed", deleted.error.code);
      return json(req, { success: false, error: "Cancellation failed" }, 500);
    }
    if (!deleted.data) {
      return json(
        req,
        { success: false, error: "Invalid or expired link" },
        410,
      );
    }
    return json(req, { success: true, eventDate: claim.eventDate });
  }

  if (body.action !== undefined) {
    return json(req, { success: false, error: "Invalid action" }, 400);
  }

  const eventDate = typeof body.eventDate === "string" && body.eventDate
    ? body.eventDate
    : nextFridayDate();

  const wantsFood = boolish(
    body.food_registration ?? body.wantsFood ?? body.food,
  );
  const { data: registrationId, error } = await (admin as any).rpc(
    "upsert_party_registration",
    {
      p_event_date: eventDate,
      p_name: body.name ?? body.fullName ?? body.full_name ?? null,
      p_email: body.email ?? null,
      p_phone: body.phone ?? null,
      p_wants_food: wantsFood,
      p_message: typeof body.message === "string" ? body.message : null,
      p_source: "party-registration",
    },
  );

  if (error) {
    return json(req, { success: false, error: "Registration failed" }, 500);
  }

  const discord = await dispatchPartyDiscordNotifications(
    admin,
    1,
    registrationId as string,
  );
  let count: number | null = null;
  if (wantsFood) {
    const { data } = await (admin as any).rpc(
      "get_party_food_registration_count",
      { p_event_date: eventDate },
    );
    const parsedCount = Number(data);
    if (Number.isFinite(parsedCount)) count = parsedCount;
  }

  return json(req, {
    success: true,
    eventDate,
    discordNotification: discord.sent > 0 ? "sent" : "queued",
    ...(count === null ? {} : { count }),
  });
});
