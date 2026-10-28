const SUPABASE_URL = "https://kbpuhcuiljbwgxgiauku.supabase.co";

function json(body, status = 200) {
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

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON" }, 400);
  }

  if (
    !body || typeof body !== "object" ||
    !["request-cancellation", "cancel"].includes(body.action)
  ) {
    return json({ success: false, error: "Invalid action" }, 400);
  }

  try {
    const response = await fetch(
      `${String(env.SUPABASE_URL || SUPABASE_URL).replace(/\/$/, "")}/functions/v1/register-party`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body.action === "cancel"
          ? { action: "cancel", token: body.token }
          : { action: "request-cancellation", email: body.email }),
      },
    );
    const data = await response.json().catch(() => ({}));
    return json(data, response.status);
  } catch (error) {
    console.error("Party cancellation request failed", error);
    return json({ success: false, error: "Server error" }, 502);
  }
}
