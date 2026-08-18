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

function registrationPrefix(eventDate) {
  return `event:${eventDate}:food_email:`;
}

function getBaseCount(env) {
  const count = Number(env.FOOD_REGISTRATION_BASE_COUNT || 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function getSupabaseServiceKey(env) {
  return env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function getSupabaseUrl(env) {
  return String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, "");
}

function hasSupabaseRpcConfig(env) {
  return Boolean(getSupabaseUrl(env) && getSupabaseServiceKey(env));
}

async function callSupabaseRpc(env, name, body) {
  const supabaseUrl = getSupabaseUrl(env);
  const serviceKey = getSupabaseServiceKey(env);

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Supabase is not configured");
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Supabase RPC failed: ${response.status}`);
  }

  return response.json();
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
  if (!getSupabaseServiceKey(env)) {
    return callSupabaseFunction(env, "register-party", {
      eventDate: payload.event_date,
      name: payload.name,
      email: payload.email,
      phone: payload.phone || null,
      food_registration: payload.food_registration,
      message: payload.message || null,
    });
  }

  return callSupabaseRpc(env, "upsert_party_registration", {
    p_event_date: payload.event_date,
    p_name: payload.name,
    p_email: payload.email,
    p_phone: payload.phone || null,
    p_wants_food: wantsFood(payload.food_registration),
    p_message: payload.message || null,
    p_source: "website-party-form",
  });
}

async function countSupabaseFoodRegistrations(env, eventDate) {
  if (!hasSupabaseRpcConfig(env)) return null;

  const count = await callSupabaseRpc(env, "get_party_food_registration_count", {
    p_event_date: eventDate,
  });

  return Number.isFinite(Number(count)) ? Number(count) : 0;
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

    let supabaseSaved = false;

    await upsertSupabaseRegistration(env, payload);
    supabaseSaved = true;

    let data = { success: true };
    let responseStatus = 200;

    if (env.N8N_WEBHOOK_URL) {
      try {
        const res = await fetch(env.N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        responseStatus = res.status;
        data = await res.json();

        if (!res.ok || !data.success) {
          if (!supabaseSaved) {
            return json(data, { status: responseStatus }, headers);
          }

          data = {
            ...data,
            success: true,
            webhookWarning: "Discord webhook failed, but registration was saved.",
          };
          responseStatus = 200;
        }
      } catch (error) {
        if (!supabaseSaved) {
          return json({ success: false, error: "Registration failed" }, { status: 500 }, headers);
        }

        data = {
          success: true,
          webhookWarning: "Discord webhook failed, but registration was saved.",
        };
        responseStatus = 200;
      }
    } else if (!supabaseSaved) {
      return json({ success: false, error: "Server is not configured" }, { status: 500 }, headers);
    }

    let foodRegistrationCount;

    if (data.success && wantsFood(body.food_registration)) {
      foodRegistrationCount = await countSupabaseFoodRegistrations(env, eventDate);
    }

    if (data.success && wantsFood(body.food_registration) && typeof foodRegistrationCount !== "number" && env.PARTY_COUNTER) {
      const emailHash = await hashEmail(email);
      const key = registrationKey(eventDate, emailHash);
      const existing = await env.PARTY_COUNTER.get(key);

      if (!existing) {
        await env.PARTY_COUNTER.put(key, JSON.stringify({
          source: "form",
          submittedAt: new Date().toISOString(),
        }));
      }

      foodRegistrationCount = getBaseCount(env) + await countRegistrations(env, eventDate);
    }

    return json({
      ...data,
      eventDate,
      supabaseSaved,
      ...(typeof foodRegistrationCount === "number" ? { count: foodRegistrationCount } : {}),
    }, { status: responseStatus }, headers);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server error";
    return json({ success: false, error: message }, { status: 500 }, headers);
  }
}
