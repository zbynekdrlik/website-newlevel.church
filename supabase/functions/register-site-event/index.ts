import {
  corsHeaders,
  createAdminClient,
  json,
  normalizeContact,
  readJsonBody,
  readServiceKey,
  validateRequestBasics,
} from "../_shared/contact.ts";
import { dispatchSiteEventDiscordNotifications } from "../_shared/site_event_discord.ts";

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

  const body = parsed.data;
  const slug = typeof body.eventSlug === "string" ? body.eventSlug.trim() : "";
  if (!/^[a-z0-9-]{1,100}$/.test(slug)) {
    return json(req, { success: false, error: "Invalid event" }, 400);
  }
  if (typeof body.wantsFood !== "boolean") {
    return json(
      req,
      { success: false, error: "Choose whether you want food" },
      400,
    );
  }

  const contact = normalizeContact(body, "site-event-registration");
  if (
    !contact.ok || !contact.data.name || contact.data.name.length < 2 ||
    !contact.data.email || !contact.data.phone
  ) {
    return json(req, { success: false, error: "Invalid contact details" }, 400);
  }

  const admin = createAdminClient(readServiceKey());
  if (!admin) {
    return json(
      req,
      { success: false, error: "Server is not configured" },
      500,
    );
  }

  const { data: event, error: eventError } = await admin.schema("invitation")
    .from("site_events")
    .select("id,status,registration_closes_at")
    .eq("slug", slug).maybeSingle();
  if (eventError) {
    console.error("Site event lookup failed", eventError.code);
    return json(
      req,
      { success: false, error: "Registration is unavailable" },
      500,
    );
  }
  if (!event) {
    return json(req, { success: false, error: "Event was not found" }, 404);
  }
  if (
    event.status !== "open" ||
    Date.now() >= new Date(event.registration_closes_at).getTime()
  ) {
    return json(req, { success: false, error: "Registration is closed" }, 410);
  }

  const { data: registration, error: registrationError } = await admin
    .schema("invitation").from("site_event_registrations")
    .upsert({
      event_id: event.id,
      name: contact.data.name,
      email: contact.data.email,
      phone: contact.data.phone,
      wants_food: body.wantsFood,
      updated_at: new Date().toISOString(),
    }, { onConflict: "event_id,email" })
    .select("id").single();
  if (registrationError || !registration) {
    console.error(
      "Site event registration failed",
      registrationError?.code ?? "no_data",
    );
    return json(req, { success: false, error: "Registration failed" }, 500);
  }

  const discord = await dispatchSiteEventDiscordNotifications(
    admin,
    1,
    registration.id,
  );
  return json(req, {
    success: true,
    discordNotification: discord.sent > 0 ? "sent" : "queued",
  });
});
