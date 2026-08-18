import { json, readJsonBody } from "../_shared/contact.ts";
import { requireAdmin } from "../_shared/admin.ts";
import { buildRegistrationUrl } from "../_shared/registration_url.ts";

type QueueBody = {
  eventDate?: string;
  scheduledFor?: string;
  strategy?:
    | "sms_then_email"
    | "email_only"
    | "sms_only"
    | "whatsapp_then_email"
    | "whatsapp_only";
  kind?: "party_invitation" | "party_reminder" | "custom";
  automationId?: string;
  targetContactIds?: string[];
  targetEmails?: string[];
  targetNames?: string[];
  body?: string;
  subject?: string;
};

type QueueContact = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  sms_enabled: boolean;
  email_enabled: boolean;
};

type RegistrationRow = {
  contact_id: string;
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

function sqlDateLiteral(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid eventDate");
  return value;
}

function optionalStringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Invalid target list");
  if (value.length > maxItems) throw new Error("Too many targets");

  return value.map((item) => {
    if (typeof item !== "string") throw new Error("Invalid target list");
    const trimmed = item.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();
    if (!trimmed || trimmed.length > maxLength) {
      throw new Error("Invalid target list");
    }
    return trimmed;
  });
}

Deno.serve(async (req) => {
  const auth = await requireAdmin(req);
  if (auth.ok === false) return auth.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const body = parsed.data as QueueBody;
  const eventDate = sqlDateLiteral(body.eventDate ?? nextFridayDate());
  const strategy = body.strategy ?? "sms_then_email";
  const kind = body.kind ?? "party_invitation";
  const automationId = body.automationId ??
    `party-${kind}-${eventDate}-${strategy}`;
  const scheduledFor = body.scheduledFor ?? new Date().toISOString();
  const targetContactIds = optionalStringList(body.targetContactIds, 100, 64);
  const targetEmails = optionalStringList(body.targetEmails, 100, 254)
    .map((email) => email.toLowerCase());
  const targetNames = optionalStringList(body.targetNames, 100, 120)
    .map((name) => name.toLowerCase());
  const hasTargets = targetContactIds.length > 0 || targetEmails.length > 0 ||
    targetNames.length > 0;
  const messageBody = body.body ??
    "Ahoj {{name}}, tento piatok je New Level Youth. Bude jedlo, hry, karaoke a dobra atmosfera. Das nam prosim vediet, ci prides?";
  const subject = body.subject ?? "Prides tento piatok na New Level Youth?";

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

  const { data: batch, error: batchError } = await auth.admin
    .schema("invitation")
    .from("message_batches")
    .insert({
      event_id: event.id,
      kind,
      channel_strategy: strategy,
      created_by: auth.user.id,
    })
    .select("id")
    .single();

  if (batchError || !batch) {
    return json(req, { success: false, error: "Batch create failed" }, 500);
  }

  const { data: contacts, error: contactsError } = await auth.admin
    .schema("invitation")
    .from("contacts")
    .select("id,name,email,phone,sms_enabled,email_enabled")
    .eq("active", true);

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

  const registered = new Set(
    (registrations as RegistrationRow[]).map((row) => row.contact_id),
  );
  const targetIds = new Set(targetContactIds);
  const targetEmailSet = new Set(targetEmails);
  const targetNameSet = new Set(targetNames);
  const rows = (contacts as QueueContact[])
    .filter((contact) => !registered.has(contact.id))
    .filter((contact) => {
      if (!hasTargets) return true;
      const name = (contact.name ?? "").toLowerCase();
      const email = (contact.email ?? "").toLowerCase();
      return targetIds.has(contact.id) || targetEmailSet.has(email) ||
        targetNameSet.has(name);
    })
    .flatMap((contact) => {
      const registrationUrl = buildRegistrationUrl(contact);
      const bodyText = messageBody
        .replaceAll("{{name}}", contact.name ?? "kamarát")
        .replaceAll("{{registration_url}}", registrationUrl);
      if (
        (strategy === "sms_then_email" || strategy === "sms_only") &&
        contact.phone &&
        contact.sms_enabled
      ) {
        return [{
          batch_id: batch.id,
          event_id: event.id,
          contact_id: contact.id,
          automation_id: automationId,
          channel: "sms",
          recipient: contact.phone,
          body: bodyText,
          scheduled_for: scheduledFor,
        }];
      }
      if (
        strategy !== "sms_only" && strategy !== "whatsapp_only" &&
        contact.email && contact.email_enabled
      ) {
        return [{
          batch_id: batch.id,
          event_id: event.id,
          contact_id: contact.id,
          automation_id: automationId,
          channel: "email",
          recipient: contact.email,
          subject,
          body: bodyText,
          scheduled_for: scheduledFor,
        }];
      }
      return [];
    });

  if (rows.length) {
    const { error } = await auth.admin
      .schema("invitation")
      .from("message_queue")
      .upsert(rows, {
        onConflict: "automation_id,contact_id,channel",
        ignoreDuplicates: true,
      });

    if (error) {
      return json(req, { success: false, error: "Queue insert failed" }, 500);
    }
  }

  return json(req, {
    success: true,
    eventDate,
    batchId: batch.id,
    automationId,
    queued: rows.length,
    skippedRegistered: registered.size,
    targeted: hasTargets,
  });
});
