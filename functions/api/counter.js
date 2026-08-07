const TIME_ZONE = "Europe/Bratislava";

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

  if (day === 5 || day === 6) {
    daysUntilFriday = day === 5 ? 7 : 6;
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

async function hashEmail(email) {
  const bytes = new TextEncoder().encode(normalizeEmail(email));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function registrationPrefix(eventDate) {
  return `event:${eventDate}:food_email:`;
}

function getBaseCount(env) {
  const count = Number(env.FOOD_REGISTRATION_BASE_COUNT || 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

async function countRegistrations(env, eventDate) {
  let cursor;
  let count = 0;

  do {
    const page = await env.PARTY_COUNTER.list({
      prefix: registrationPrefix(eventDate),
      cursor,
    });

    count += page.keys.length;
    cursor = page.cursor;

    if (page.list_complete) break;
  } while (cursor);

  return count;
}

async function clearRegistrations(env, eventDate) {
  let cursor;

  do {
    const page = await env.PARTY_COUNTER.list({
      prefix: registrationPrefix(eventDate),
      cursor,
    });

    await Promise.all(page.keys.map((key) => env.PARTY_COUNTER.delete(key.name)));
    cursor = page.cursor;

    if (page.list_complete) break;
  } while (cursor);
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (!env.PARTY_COUNTER) {
    return json({ error: "Counter storage unavailable" }, { status: 503 }, headers);
  }

  if (request.method === "GET") {
    const url = new URL(request.url);
    const eventDate = url.searchParams.get("eventDate") || getCurrentEventDate();
    const registrationsCount = await countRegistrations(env, eventDate);
    const baseCount = getBaseCount(env);

    return json({
      count: baseCount + registrationsCount,
      baseCount,
      registrationsCount,
      eventDate,
      source: "PARTY_COUNTER_EVENT_EMAILS",
    }, {}, headers);
  }

  if (request.method === "POST") {
    const body = await request.json();

    if (!body.token || body.token !== env.UPDATE_TOKEN) {
      return json({ error: "Unauthorized" }, { status: 401 }, headers);
    }

    const eventDate = body.eventDate || getCurrentEventDate();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return json({ error: "Invalid eventDate" }, { status: 400 }, headers);
    }

    if (!Array.isArray(body.emails)) {
      return json({ error: "Provide an emails array for real backfill" }, { status: 400 }, headers);
    }

    const uniqueEmails = [...new Set(body.emails.map(normalizeEmail).filter(Boolean))];
    const now = new Date().toISOString();

    await clearRegistrations(env, eventDate);

    await Promise.all(uniqueEmails.map(async (email) => {
      const key = `${registrationPrefix(eventDate)}${await hashEmail(email)}`;
      await env.PARTY_COUNTER.put(key, JSON.stringify({
        source: "backfill",
        updatedAt: now,
      }));
    }));

    const registrationsCount = await countRegistrations(env, eventDate);
    const baseCount = getBaseCount(env);
    return json({
      success: true,
      count: baseCount + registrationsCount,
      baseCount,
      registrationsCount,
      eventDate,
      source: "PARTY_COUNTER_EVENT_EMAILS",
    }, {}, headers);
  }

  return json({ error: "Method not allowed" }, { status: 405 }, headers);
}
