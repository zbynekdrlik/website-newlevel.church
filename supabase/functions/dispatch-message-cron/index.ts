import {
  createAdminClient,
  json,
  readJsonBody,
  readServiceKey,
} from "../_shared/contact.ts";
import { dispatchDueMessages } from "../_shared/message_queue.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return json(req, { success: false, error: "Method not allowed" }, 405);
  }

  const cronSecret = Deno.env.get("CRON_SECRET")?.trim();
  const requestSecret = req.headers.get("x-cron-secret")?.trim();
  if (!cronSecret || !requestSecret || requestSecret !== cronSecret) {
    return json(req, { success: false, error: "Forbidden" }, 403);
  }

  const admin = createAdminClient(readServiceKey());
  if (!admin) {
    return json(
      req,
      { success: false, error: "Server is not configured" },
      500,
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const limit = Math.max(1, Math.min(Number(parsed.data.limit ?? 20), 50));
  const result = await dispatchDueMessages(admin, limit);
  if (!result.ok) {
    return json(
      req,
      { success: false, error: result.error, details: result.details },
      500,
    );
  }

  return json(req, {
    success: true,
    processed: result.processed,
    results: result.results,
  });
});
