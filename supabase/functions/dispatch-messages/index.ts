import { json, readJsonBody } from "../_shared/contact.ts";
import { requireAdmin } from "../_shared/admin.ts";
import { sendTextBeeSms } from "../_shared/textbee.ts";

type DispatchMessagesBody = {
  automationId?: string;
  eventDate?: string;
  message?: string;
  limit?: number;
};

function nextFridayDate() {
  const now = new Date();
  const bratislava = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Bratislava" }),
  );
  const day = bratislava.getDay();
  let daysUntilFriday = (5 - day + 7) % 7;
  if (day === 5 || day === 6) daysUntilFriday = day === 5 ? 7 : 6;
  bratislava.setDate(bratislava.getDate() + daysUntilFriday);
  return bratislava.toISOString().slice(0, 10);
}

function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid eventDate");
  return value;
}

Deno.serve(async (req) => {
  const auth = await requireAdmin(req);
  if (auth.ok === false) return auth.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const body = parsed.data as DispatchMessagesBody;
  const eventDate = assertDate(body.eventDate ?? nextFridayDate());
  const automationId = body.automationId ?? `party-sms-reminder-${eventDate}`;
  const smsBody = (body.message ??
    "Ahoj {{name}}, tento piatok je New Level Party. Este nie si prihlaseny/a, das vediet, ci prides?")
    .trim();
  const limit = Math.max(1, Math.min(Number(body.limit ?? 30), 100));

  if (!smsBody || smsBody.length > 1000) {
    return json(req, { success: false, error: "Invalid SMS message" }, 400);
  }

  const { data: event, error: eventError } = await auth.admin
    .schema("invitation")
    .from("party_events")
    .upsert({
      event_date: eventDate,
      title: "New Level Party",
      starts_at: `${eventDate}T16:00:00+02:00`,
      registration_deadline: `${eventDate}T00:00:00+02:00`,
      status: "open",
    }, { onConflict: "event_date" })
    .select("id")
    .single();

  if (eventError || !event) {
    return json(req, { success: false, error: "Event create failed" }, 500);
  }

  const { data: contacts, error: contactsError } = await auth.admin
    .schema("invitation")
    .from("contacts")
    .select("id,name,phone")
    .eq("active", true)
    .eq("sms_enabled", true)
    .not("phone", "is", null)
    .limit(limit);

  if (contactsError || !contacts) {
    return json(req, { success: false, error: "Contacts load failed" }, 500);
  }

  const { data: registrations, error: registrationsError } = await auth.admin
    .schema("invitation")
    .from("party_registrations")
    .select("contact_id")
    .eq("event_id", event.id);

  if (registrationsError || !registrations) {
    return json(
      req,
      { success: false, error: "Registrations load failed" },
      500,
    );
  }

  const { data: sentLogs, error: logsError } = await auth.admin
    .schema("invitation")
    .from("message_logs")
    .select("contact_id")
    .eq("automation_id", automationId)
    .eq("channel", "sms");

  if (logsError || !sentLogs) {
    return json(req, { success: false, error: "Message log load failed" }, 500);
  }

  const registered = new Set(registrations.map((row) => row.contact_id));
  const alreadySent = new Set(sentLogs.map((row) => row.contact_id));
  const candidates = contacts
    .filter((contact) => !registered.has(contact.id))
    .filter((contact) => !alreadySent.has(contact.id));

  const results = [];

  for (const contact of candidates) {
    const rendered = smsBody.replaceAll("{{name}}", contact.name ?? "kamarád");
    const { data: log, error: logError } = await auth.admin
      .schema("invitation")
      .from("message_logs")
      .insert({
        contact_id: contact.id,
        automation_id: automationId,
        channel: "sms",
        provider: "textbee",
        status: "queued",
        metadata: { event_date: eventDate },
      })
      .select("id")
      .single();

    if (logError || !log) {
      results.push({ contactId: contact.id, ok: false, skipped: true });
      continue;
    }

    const result = await sendTextBeeSms(contact.phone, rendered);
    const didSend = result.ok === true;
    const sentAt = didSend ? new Date().toISOString() : null;

    await auth.admin
      .schema("invitation")
      .from("message_logs")
      .update({
        status: didSend ? "sent" : "failed",
        provider_message_id: didSend ? result.providerMessageId : null,
        error_code: didSend ? null : result.errorCode,
        error_message: didSend ? null : result.errorMessage,
        sent_at: sentAt,
      })
      .eq("id", log.id);

    results.push({ contactId: contact.id, ok: didSend });
  }

  return json(req, {
    success: true,
    automationId,
    eventDate,
    eligible: candidates.length,
    sent: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok && !result.skipped).length,
    skippedRegistered: registered.size,
    skippedAlreadySent: alreadySent.size,
    skippedLocked: results.filter((result) => result.skipped).length,
  });
});
