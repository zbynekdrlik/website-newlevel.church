const TIME_ZONE = "Europe/Bratislava";
const DEFAULT_SUPABASE_URL = "https://kbpuhcuiljbwgxgiauku.supabase.co";

function json(body, init = {}, headers) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function getBratislavaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function getCurrentEventDate(date = new Date()) {
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const parts = getBratislavaDateParts(date);
  const day = weekdayMap[parts.weekday] ?? 0;
  let daysUntilFriday = (5 - day + 7) % 7;

  if (day === 6) {
    daysUntilFriday = 6;
  }

  const target = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) + daysUntilFriday,
  ));

  return target.toISOString().slice(0, 10);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getSupabaseUrl(env) {
  return String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, "");
}

async function callSupabaseFunction(env, name, body) {
  const supabaseUrl = getSupabaseUrl(env);

  if (!supabaseUrl) {
    throw new Error("Supabase URL is not configured");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Supabase function failed: ${response.status}`);
  }

  return data;
}

async function upsertSupabaseRegistration(env, payload) {
  return callSupabaseFunction(env, "register-party", {
    eventDate: payload.event_date,
    name: payload.name,
    email: payload.email,
    phone: payload.phone || null,
    food_registration: payload.food_registration,
    message: payload.message || null,
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 }, headers);
  }

  try {
    const body = await request.json();
    const email = normalizeEmail(body.email);

    if (!body.name || !email) {
      return json({ success: false, error: "Missing required fields" }, { status: 400 }, headers);
    }

    const eventDate = getCurrentEventDate();
    const payload = {
      ...body,
      email,
      event_date: eventDate,
    };

    const data = await upsertSupabaseRegistration(env, payload);

    return json({
      ...data,
      eventDate: data.eventDate || eventDate,
      supabaseSaved: true,
    }, { status: 200 }, headers);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server error";
    return json({ success: false, error: message }, { status: 500 }, headers);
  }
}
