import { createClient } from "npm:@supabase/supabase-js@2";

export type ContactInput = {
  name?: unknown;
  fullName?: unknown;
  full_name?: unknown;
  email?: unknown;
  phone?: unknown;
  source?: unknown;
};

type NormalizedContact = {
  name: string | null;
  email: string | null;
  phone: string | null;
  source: string;
};

type RegisterContactResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

const MAX_JSON_BYTES = 64 * 1024;
const MAX_IMPORT_JSON_BYTES = 1024 * 1024;

export function readServiceKey() {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    return JSON.parse(secretKeys).default as string;
  }

  return Deno.env.get("SUPABASE_SECRET_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

export function readPublishableKey() {
  const publishableKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (publishableKeys) {
    return JSON.parse(publishableKeys).default as string;
  }

  return Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY") ?? "";
}

export function createAdminClient(serviceKey: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supabaseUrl || !serviceKey) return null;

  return createClient(supabaseUrl, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function createUserClient(publishableKey: string, authHeader: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supabaseUrl || !publishableKey) return null;

  return createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function allowedOrigins() {
  return (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function corsHeaders(req: Request) {
  const origin = req.headers.get("origin");
  const allowed = allowedOrigins();
  const allowOrigin = origin && allowed.includes(origin) ? origin : "";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, x-admin-sms-key, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function validateRequestBasics(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && !allowedOrigins().includes(origin)) {
    return {
      ok: false as const,
      response: json(req, { success: false, error: "Forbidden" }, 403),
    };
  }

  if (req.method !== "POST") {
    return {
      ok: false as const,
      response: json(req, { success: false, error: "Method not allowed" }, 405),
    };
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false as const,
      response: json(
        req,
        { success: false, error: "Content-Type must be application/json" },
        415,
      ),
    };
  }

  return { ok: true as const };
}

export async function readJsonBody(req: Request, maxBytes = MAX_JSON_BYTES) {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    return { ok: false as const, error: "Request body is too large" };
  }

  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return { ok: false as const, error: "Request body is too large" };
  }

  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false as const, error: "JSON body must be an object" };
    }

    return { ok: true as const, data: data as Record<string, unknown> };
  } catch {
    return { ok: false as const, error: "Invalid JSON body" };
  }
}

export async function readImportJsonBody(req: Request) {
  return await readJsonBody(req, MAX_IMPORT_JSON_BYTES);
}

function optionalText(value: unknown, maxLength: number) {
  if (value === undefined || value === null) {
    return { ok: true as const, value: null };
  }

  if (typeof value !== "string") return { ok: false as const };

  const trimmed = value.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();
  if (!trimmed) return { ok: true as const, value: null };
  if (trimmed.length > maxLength) return { ok: false as const };

  return { ok: true as const, value: trimmed };
}

function normalizeEmail(value: unknown) {
  const text = optionalText(value, 254);
  if (!text.ok) return { ok: false as const, error: "Invalid email" };
  if (!text.value) return { ok: true as const, value: null };

  const email = text.value.toLowerCase();
  const emailPattern =
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

  if (!emailPattern.test(email)) {
    return { ok: false as const, error: "Invalid email" };
  }

  return { ok: true as const, value: email };
}

function normalizePhone(value: unknown) {
  const text = optionalText(value, 32);
  if (!text.ok) return { ok: false as const, error: "Invalid phone" };
  if (!text.value) return { ok: true as const, value: null };

  if (!/^[+\d\s().-]+$/.test(text.value)) {
    return { ok: false as const, error: "Invalid phone" };
  }

  let phone = text.value.replace(/[^\d+]/g, "");
  if (phone.includes("+") && !phone.startsWith("+")) {
    return { ok: false as const, error: "Invalid phone" };
  }

  phone = phone.replace(/(?!^)\+/g, "");

  if (phone.startsWith("00")) {
    phone = `+${phone.slice(2)}`;
  }

  const countryCode = Deno.env.get("DEFAULT_PHONE_COUNTRY_CODE")?.trim();
  if (countryCode && /^0\d+$/.test(phone)) {
    phone = `${countryCode}${phone.replace(/^0+/, "")}`;
  }

  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false as const, error: "Invalid phone" };
  }

  return { ok: true as const, value: phone };
}

export function normalizeContact(input: ContactInput, fallbackSource: string) {
  const name = optionalText(
    input.name ?? input.fullName ?? input.full_name,
    120,
  );
  if (!name.ok) {
    return { ok: false as const, status: 400, error: "Invalid name" };
  }

  const source = optionalText(input.source, 80);
  if (!source.ok) {
    return { ok: false as const, status: 400, error: "Invalid source" };
  }

  const email = normalizeEmail(input.email);
  if (!email.ok) return { ok: false as const, status: 400, error: email.error };

  const phone = normalizePhone(input.phone);
  if (!phone.ok) return { ok: false as const, status: 400, error: phone.error };

  if (!email.value && !phone.value) {
    return {
      ok: false as const,
      status: 400,
      error: "Email or phone is required",
    };
  }

  return {
    ok: true as const,
    data: {
      name: name.value,
      email: email.value,
      phone: phone.value,
      source: source.value ?? fallbackSource,
    } satisfies NormalizedContact,
  };
}

export async function registerContact(
  admin: any,
  input: ContactInput,
  fallbackSource: string,
): Promise<RegisterContactResult> {
  const normalized = normalizeContact(input, fallbackSource);
  if (!normalized.ok) {
    return {
      ok: false,
      status: normalized.status,
      error: normalized.error,
    };
  }

  const { error } = await admin.rpc("register_invitation_contact", {
    p_name: normalized.data.name,
    p_email: normalized.data.email,
    p_phone: normalized.data.phone,
    p_source: normalized.data.source,
  });

  if (error) {
    return {
      ok: false as const,
      status: error.code === "23505" ? 409 : 500,
      error: error.code === "23505"
        ? "Contact matches a different existing contact"
        : "Contact registration failed",
    };
  }

  return { ok: true as const };
}
