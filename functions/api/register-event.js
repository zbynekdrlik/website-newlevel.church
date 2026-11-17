const DEFAULT_SUPABASE_URL = "https://kbpuhcuiljbwgxgiauku.supabase.co";

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 8192) {
    return json({ success: false, error: "Request body is too large" }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const encodedBody = JSON.stringify(body);
  if (new TextEncoder().encode(encodedBody).byteLength > 8192) {
    return json({ success: false, error: "Request body is too large" }, 413);
  }

  const supabaseUrl = String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL)
    .replace(/\/$/, "");
  try {
    const response = await fetch(
      supabaseUrl + "/functions/v1/register-site-event",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: encodedBody,
        signal: AbortSignal.timeout(15000),
      },
    );
    const data = await response.json().catch(() => ({
      success: false,
      error: "Registration is unavailable",
    }));
    return json(data, response.status);
  } catch {
    return json({ success: false, error: "Registration is unavailable" }, 503);
  }
}
