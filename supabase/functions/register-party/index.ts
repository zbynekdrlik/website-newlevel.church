import {
  corsHeaders,
  createAdminClient,
  json,
  readJsonBody,
  readServiceKey,
  validateRequestBasics,
} from "../_shared/contact.ts";

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

  const basics = validateRequestBasics(req);
  if (!basics.ok) return basics.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const body = parsed.data;
  const admin = createAdminClient(readServiceKey());
  if (!admin) {
    return json(
      req,
      { success: false, error: "Server is not configured" },
      500,
    );
  }

  const eventDate = typeof body.eventDate === "string" && body.eventDate
    ? body.eventDate
    : nextFridayDate();

  const { error } = await (admin as any).rpc("upsert_party_registration", {
    p_event_date: eventDate,
    p_name: body.name ?? body.fullName ?? body.full_name ?? null,
    p_email: body.email ?? null,
    p_phone: body.phone ?? null,
    p_wants_food: boolish(
      body.food_registration ?? body.wantsFood ?? body.food,
    ),
    p_message: typeof body.message === "string" ? body.message : null,
    p_source: "party-registration",
  });

  if (error) {
    return json(req, { success: false, error: "Registration failed" }, 500);
  }

  return json(req, { success: true, eventDate });
});
