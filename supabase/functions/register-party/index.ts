import {
  corsHeaders,
  createAdminClient,
  json,
  readJsonBody,
  readServiceKey,
  validateRequestBasics,
} from "../_shared/contact.ts";
import { dispatchPartyDiscordNotifications } from "../_shared/party_discord.ts";

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
