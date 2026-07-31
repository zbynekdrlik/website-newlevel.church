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

function wantsFood(value) {
  return value === true || ["ano", "true", "on", "1", "yes"].includes(String(value || "").toLowerCase());
}

function registrationKey(eventDate, emailHash) {
  return `event:${eventDate}:food_email:${emailHash}`;
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

    const res = await fetch(env.N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (res.ok && data.success && wantsFood(body.food_registration) && env.PARTY_COUNTER) {
      const emailHash = await hashEmail(email);
      const key = registrationKey(eventDate, emailHash);
      const existing = await env.PARTY_COUNTER.get(key);

      if (!existing) {
        await env.PARTY_COUNTER.put(key, JSON.stringify({
          source: "form",
          submittedAt: new Date().toISOString(),
        }));
      }
    }

    return json(data, { status: res.status }, headers);
  } catch (err) {
    return json({ success: false, error: "Server error" }, { status: 500 }, headers);
  }
}
