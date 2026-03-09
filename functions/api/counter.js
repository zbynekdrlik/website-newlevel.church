export async function onRequest(context) {
  const { request, env } = context;
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method === "GET") {
    const value = await env.PARTY_COUNTER.get("registration_count");
    const count = value ? parseInt(value, 10) : 0;
    return new Response(JSON.stringify({ count }), { headers });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const token = body.token;

    if (!token || token !== env.UPDATE_TOKEN) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const count = parseInt(body.count, 10);
    if (isNaN(count) || count < 0) {
      return new Response(JSON.stringify({ error: "Invalid count" }), {
        status: 400,
        headers,
      });
    }

    await env.PARTY_COUNTER.put("registration_count", count.toString());
    return new Response(JSON.stringify({ success: true, count }), { headers });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers,
  });
}
