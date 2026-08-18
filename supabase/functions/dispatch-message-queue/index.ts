import { json, readJsonBody } from "../_shared/contact.ts";
import { requireAdmin } from "../_shared/admin.ts";
import { dispatchDueMessages } from "../_shared/message_queue.ts";
import {
  materializeDueSmsCampaigns,
  updateSmsCampaignStatuses,
} from "../_shared/sms_campaigns.ts";

type DispatchBody = {
  limit?: number;
};

Deno.serve(async (req) => {
  const auth = await requireAdmin(req);
  if (auth.ok === false) return auth.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const body = parsed.data as DispatchBody;
  const limit = Math.max(1, Math.min(Number(body.limit ?? 20), 50));

  const campaigns = await materializeDueSmsCampaigns(auth.admin, 10);
  const result = await dispatchDueMessages(auth.admin, limit);
  await updateSmsCampaignStatuses(auth.admin);
  if (!result.ok) {
    return json(
      req,
      { success: false, error: result.error, details: result.details },
      500,
    );
  }

  return json(req, {
    success: true,
    campaigns,
    processed: result.processed,
    results: result.results,
  });
});
