import {
  corsHeaders,
  createAdminClient,
  json,
  readJsonBody,
  readServiceKey,
  validateRequestBasics,
} from "../_shared/contact.ts";

type DiscordResult =
  | { ok: true }
  | { ok: false; error: "not_configured" | "delivery_failed" };

function cleanDiscordText(value: unknown, fallback: string, maxLength = 500) {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function discordEventDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat("sk-SK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Bratislava",
  }).format(new Date(`${value}T12:00:00Z`));
}

async function sendDiscordNotification(
  payload: Record<string, unknown>,
  eventDate: string,
): Promise<DiscordResult> {
  const webhookUrl = Deno.env.get("DISCORD_PARTY_WEBHOOK_URL")?.trim();
  if (!webhookUrl) return { ok: false, error: "not_configured" };

  const name = cleanDiscordText(
    payload.name ?? payload.fullName ?? payload.full_name,
    "neuvedené",
    120,
  );
  const email = cleanDiscordText(payload.email, "neuvedené", 254);
  const phone = cleanDiscordText(payload.phone, "neuvedené", 32);
  const message = cleanDiscordText(payload.message, "žiadna", 500);
  const food = boolish(
      payload.food_registration ?? payload.wantsFood ?? payload.food,
    )
    ? "ÁNO"
    : "NIE";

  const discordPayload = {
    username: "New Level registrácie",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "Nová registrácia na Party",
      color: 0x9acd32,
      fields: [
        { name: "Meno", value: name, inline: false },
        { name: "Email", value: email, inline: false },
        { name: "Telefón", value: phone, inline: false },
        { name: "Jedlo", value: food, inline: true },
        {
          name: "Termín",
          value: discordEventDate(eventDate),
          inline: true,
        },
        { name: "Správa", value: message, inline: false },
      ],
      footer: { text: "Reaguj ✅ na potvrdenie registrácie." },
      timestamp: new Date().toISOString(),
    }],
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload),
      });
      if (response.ok) return { ok: true };
      if (response.status < 500 && response.status !== 429) break;
    } catch {
      // Retry transient network failures below.
    }

    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }

  return { ok: false, error: "delivery_failed" };
}

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

  const wantsFood = boolish(
    body.food_registration ?? body.wantsFood ?? body.food,
  );
  const { error } = await (admin as any).rpc("upsert_party_registration", {
    p_event_date: eventDate,
    p_name: body.name ?? body.fullName ?? body.full_name ?? null,
    p_email: body.email ?? null,
    p_phone: body.phone ?? null,
    p_wants_food: wantsFood,
    p_message: typeof body.message === "string" ? body.message : null,
    p_source: "party-registration",
  });

  if (error) {
    return json(req, { success: false, error: "Registration failed" }, 500);
  }

  const discord = await sendDiscordNotification(body, eventDate);
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
    discordNotification: discord.ok ? "sent" : discord.error,
    ...(discord.ok ? {} : {
      notificationWarning: "Registration saved, Discord notification failed",
    }),
    ...(count === null ? {} : { count }),
  });
});
