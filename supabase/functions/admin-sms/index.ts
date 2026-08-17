import {
  corsHeaders,
  createAdminClient,
  json,
  readJsonBody,
  readServiceKey,
  validateRequestBasics,
} from "../_shared/contact.ts";
import {
  normalizeE164,
  sendInfobipSms,
  smsSegmentInfo,
  smsTestModeConfig,
} from "../_shared/infobip.ts";
import { dispatchDueMessages } from "../_shared/message_queue.ts";

type AudienceType =
  | "all_with_phone"
  | "registered_for_event"
  | "not_registered_for_event"
  | "previously_registered_not_registered"
  | "custom_selection";

type AdminSmsBody = {
  action?: string;
  eventId?: string;
  eventDate?: string;
  audienceType?: AudienceType;
  selectedContactIds?: string[];
  name?: string;
  message?: string;
  subject?: string;
  scheduledFor?: string;
  sendNow?: boolean;
  phone?: string;
  limit?: number;
};

type ContactRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  sms_enabled: boolean;
  email_enabled: boolean;
  created_at: string;
};

type RegistrationRow = {
  contact_id: string;
  event_id: string;
};

type AudienceContact = ContactRow & {
  normalizedPhone: string | null;
  registeredForSelected: boolean;
  everRegistered: boolean;
  previouslyRegisteredNotSelected: boolean;
  matches: boolean;
  eligible: boolean;
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

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function cleanUuidList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item : "")
    .filter((item) => /^[0-9a-f-]{36}$/i.test(item));
}

function readAdminSmsKey() {
  return Deno.env.get("ADMIN_SMS_KEY")?.trim() ?? "";
}

function requestAdminSmsKey(req: Request) {
  const header = req.headers.get("x-admin-sms-key")?.trim() ?? "";
  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  return header || bearer;
}

function timingSafeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }

  return diff === 0;
}

function renderMessage(
  template: string,
  contact: Record<string, unknown>,
  event: Record<string, unknown> | null,
) {
  const startsAt = typeof event?.starts_at === "string" ? event.starts_at : "";
  const eventDate = startsAt
    ? new Intl.DateTimeFormat("sk-SK", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Bratislava",
    }).format(new Date(startsAt))
    : String(event?.event_date ?? "");

  const name = typeof contact.name === "string" ? contact.name : "";
  const values: Record<string, string> = {
    name,
    first_name: name.trim().split(/\s+/)[0] || "Ahoj",
    email: typeof contact.email === "string" ? contact.email : "",
    phone: typeof contact.phone === "string" ? contact.phone : "",
    event_name: String(event?.title ?? "New Level Party"),
    event_date: eventDate,
    registration_url: "https://newlevel.church/youth/",
  };

  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, key: string) => {
    return values[key] ?? "";
  });
}

async function getOrCreateEvent(admin: any, body: AdminSmsBody) {
  if (body.eventId && /^[0-9a-f-]{36}$/i.test(body.eventId)) {
    const { data, error } = await admin
      .schema("invitation")
      .from("party_events")
      .select("id,event_date,title,starts_at,status")
      .eq("id", body.eventId)
      .maybeSingle();
    if (error) throw new Error("Event load failed");
    if (data) return data;
  }

  const eventDate = cleanText(body.eventDate, 10) ?? nextFridayDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw new Error("Invalid eventDate");
  }

  const { data, error } = await admin
    .schema("invitation")
    .from("party_events")
    .upsert({
      event_date: eventDate,
      title: "New Level Party",
      starts_at: `${eventDate}T18:00:00+02:00`,
      registration_deadline: `${eventDate}T00:00:00+02:00`,
      status: "open",
    }, { onConflict: "event_date" })
    .select("id,event_date,title,starts_at,status")
    .single();

  if (error || !data) throw new Error("Event create failed");
  return data;
}

async function loadAudience(
  admin: any,
  eventId: string,
  audienceType: AudienceType,
) {
  const { data: contacts, error: contactsError } = await admin
    .schema("invitation")
    .from("contacts")
    .select("id,name,email,phone,active,sms_enabled,email_enabled,created_at")
    .not("phone", "is", null)
    .order("created_at", { ascending: true })
    .limit(10000);

  if (contactsError || !contacts) throw new Error("Contacts load failed");

  const { data: registrations, error: registrationsError } = await admin
    .schema("invitation")
    .from("party_registrations")
    .select("contact_id,event_id")
    .limit(10000);

  if (registrationsError || !registrations) {
    throw new Error(
      registrationsError?.message
        ? `Registrations load failed: ${registrationsError.message}`
        : "Registrations load failed",
    );
  }

  const registrationRows = registrations as RegistrationRow[];
  const selectedEvent = new Set(
    registrationRows
      .filter((row: RegistrationRow) => row.event_id === eventId)
      .map((row: RegistrationRow) => row.contact_id),
  );
  const ever = new Set(
    registrationRows.map((row: RegistrationRow) => row.contact_id),
  );

  return (contacts as ContactRow[]).map(
    (contact: ContactRow): AudienceContact => {
      const normalizedPhone = normalizeE164(contact.phone);
      const registeredForSelected = selectedEvent.has(contact.id);
      const everRegistered = ever.has(contact.id);
      const previouslyRegisteredNotSelected = everRegistered &&
        !registeredForSelected;
      let matches = audienceType === "all_with_phone";

      if (audienceType === "registered_for_event") {
        matches = registeredForSelected;
      }
      if (audienceType === "not_registered_for_event") {
        matches = !registeredForSelected;
      }
      if (audienceType === "previously_registered_not_registered") {
        matches = previouslyRegisteredNotSelected;
      }
      if (audienceType === "custom_selection") matches = true;

      return {
        ...contact,
        normalizedPhone,
        registeredForSelected,
        everRegistered,
        previouslyRegisteredNotSelected,
        matches,
        eligible: Boolean(
          normalizedPhone && contact.active && contact.sms_enabled,
        ),
      };
    },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(req) });
  }

  const basics = validateRequestBasics(req);
  if (basics.ok === false) return basics.response;

  const expectedKey = readAdminSmsKey();
  const providedKey = requestAdminSmsKey(req);
  if (!expectedKey || !timingSafeEqual(providedKey, expectedKey)) {
    return json(req, { success: false, error: "Forbidden" }, 403);
  }

  const admin = createAdminClient(readServiceKey());
  if (!admin) {
    return json(req, { success: false, error: "Server not configured" }, 500);
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  const body = parsed.data as AdminSmsBody;
  const action = body.action ?? "config";

  try {
    if (action === "config") {
      return json(req, { success: true, ...smsTestModeConfig() });
    }

    if (action === "list_events") {
      const { data, error } = await admin
        .schema("invitation")
        .from("party_events")
        .select("id,event_date,title,starts_at,status")
        .order("event_date", { ascending: false })
        .limit(100);
      if (error) throw new Error("Events load failed");
      return json(req, { success: true, events: data ?? [] });
    }

    if (action === "list_audience") {
      const event = await getOrCreateEvent(admin, body);
      const audienceType = body.audienceType ?? "all_with_phone";
      const contacts = await loadAudience(admin, event.id, audienceType);
      return json(req, {
        success: true,
        event,
        contacts,
        total: contacts.length,
        matching: contacts.filter((contact: AudienceContact) =>
          contact.matches
        ).length,
        eligible: contacts.filter((contact: AudienceContact) =>
          contact.matches && contact.eligible
        ).length,
      });
    }

    if (action === "segment_info") {
      return json(req, {
        success: true,
        segmentInfo: smsSegmentInfo(String(body.message ?? "")),
      });
    }

    if (action === "send_test") {
      const phone = cleanText(body.phone, 40);
      const message = cleanText(body.message, 1000);
      if (!phone || !message) {
        return json(req, {
          success: false,
          error: "Phone and message are required",
        }, 400);
      }

      const result = await sendInfobipSms(phone, message);
      const didSend = result.ok === true;
      return json(req, {
        success: didSend,
        status: didSend ? "sent" : "failed",
        provider: "infobip",
        providerMessageId: didSend ? result.providerMessageId : null,
        errorCode: didSend ? null : result.errorCode,
        errorMessage: didSend ? null : result.errorMessage,
      }, didSend ? 200 : 502);
    }

    if (action === "create_campaign") {
      const event = await getOrCreateEvent(admin, body);
      const audienceType = body.audienceType ?? "all_with_phone";
      const selectedIds = new Set(cleanUuidList(body.selectedContactIds));
      const message = cleanText(body.message, 1000);
      const name = cleanText(body.name, 120) ?? "New Level SMS";
      const scheduledFor = body.sendNow
        ? new Date().toISOString()
        : cleanText(body.scheduledFor, 40);

      if (!message) {
        return json(req, { success: false, error: "Message is required" }, 400);
      }
      if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) {
        return json(req, {
          success: false,
          error: "Scheduled time is required",
        }, 400);
      }

      const contacts = await loadAudience(admin, event.id, audienceType);
      const recipients = contacts
        .filter((contact: AudienceContact) =>
          contact.matches && contact.eligible
        )
        .filter((contact: AudienceContact) =>
          selectedIds.size === 0 || selectedIds.has(contact.id)
        );

      if (!recipients.length) {
        return json(
          req,
          { success: false, error: "No eligible recipients" },
          400,
        );
      }

      const automationId =
        `admin-sms-${event.event_date}-${audienceType}-${crypto.randomUUID()}`;
      const { data: batch, error: batchError } = await admin
        .schema("invitation")
        .from("message_batches")
        .insert({
          event_id: event.id,
          kind: "custom",
          channel_strategy: "sms_only",
          created_by: null,
        })
        .select("id")
        .single();

      if (batchError || !batch) throw new Error("Batch create failed");

      const rows = recipients.map((contact: AudienceContact) => ({
        batch_id: batch.id,
        event_id: event.id,
        contact_id: contact.id,
        automation_id: automationId,
        channel: "sms",
        recipient: contact.normalizedPhone,
        body: renderMessage(message, contact, event),
        scheduled_for: new Date(scheduledFor).toISOString(),
        subject: name,
      }));

      const { error: queueError } = await admin
        .schema("invitation")
        .from("message_queue")
        .upsert(rows, {
          onConflict: "automation_id,contact_id,channel",
          ignoreDuplicates: true,
        });

      if (queueError) throw new Error("Queue insert failed");

      let processed = null;
      if (body.sendNow) {
        processed = await dispatchDueMessages(
          admin,
          Math.min(rows.length, 50),
        );
      }

      return json(req, {
        success: true,
        batchId: batch.id,
        automationId,
        queued: rows.length,
        processed,
      });
    }

    if (action === "history") {
      const { data, error } = await admin
        .schema("invitation")
        .from("message_queue")
        .select(
          "id,automation_id,channel,recipient,subject,status,provider,provider_message_id,last_error,scheduled_for,sent_at,created_at",
        )
        .eq("channel", "sms")
        .order("created_at", { ascending: false })
        .limit(Math.min(Number(body.limit ?? 100), 300));

      if (error) throw new Error("History load failed");
      return json(req, { success: true, messages: data ?? [] });
    }

    if (action === "process_due") {
      const limit = Math.max(1, Math.min(Number(body.limit ?? 20), 50));
      const result = await dispatchDueMessages(admin, limit);
      return json(req, { success: result.ok, result }, result.ok ? 200 : 500);
    }

    return json(req, { success: false, error: "Unknown action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMS admin failed";
    return json(req, { success: false, error: message }, 500);
  }
});
