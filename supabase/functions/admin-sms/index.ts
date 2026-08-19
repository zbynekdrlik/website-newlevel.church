import {
  corsHeaders,
  createAdminClient,
  json,
  readJsonBody,
  readServiceKey,
  validateRequestBasics,
} from "../_shared/contact.ts";
import {
  getInfobipSmsLogs,
  normalizeE164,
  normalizeSmsSender,
  sendInfobipSms,
  smsRecipientEligibility,
  smsSegmentInfo,
  smsTestModeConfig,
} from "../_shared/infobip.ts";
import { expandSmsEmojiShortcodes } from "../_shared/emoji.ts";
import { dispatchDueMessages } from "../_shared/message_queue.ts";
import {
  materializeDueSmsCampaigns,
  updateSmsCampaignStatuses,
} from "../_shared/sms_campaigns.ts";
import { buildRegistrationUrl } from "../_shared/registration_url.ts";
import { audienceMatches, type AudienceType } from "../_shared/audience.ts";

type MessageChannel = "sms" | "whatsapp" | "email";

type AdminSmsBody = {
  action?: string;
  eventId?: string;
  eventDate?: string;
  audienceType?: AudienceType;
  selectedContactIds?: string[];
  channels?: MessageChannel[];
  campaignId?: string;
  name?: string;
  message?: string;
  subject?: string;
  sender?: string;
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
  smsEligible: boolean;
  whatsappEligible: boolean;
  emailEligible: boolean;
  testModeBlocked: boolean;
};

type ManualDeliveryRow = {
  id: string;
  contact_id: string;
  recipient: string;
  body: string;
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
  const cleaned = expandSmsEmojiShortcodes(
    value
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function cleanUuidList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item : "")
    .filter((item) => /^[0-9a-f-]{36}$/i.test(item));
}

function cleanUuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)
    ? value
    : null;
}

function cleanChannels(value: unknown): MessageChannel[] {
  const allowed = new Set<MessageChannel>(["sms", "whatsapp", "email"]);
  if (!Array.isArray(value)) return ["sms"];
  const channels = value.filter((item): item is MessageChannel =>
    typeof item === "string" && allowed.has(item as MessageChannel)
  );
  return [...new Set(channels)];
}

function isValidEmail(value: string | null | undefined) {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

function channelStrategy(channels: MessageChannel[]) {
  if (channels.length === 1) {
    if (channels[0] === "email") return "email_only";
    if (channels[0] === "whatsapp") return "whatsapp_only";
    return "sms_only";
  }
  if (channels.includes("sms")) return "sms_then_email";
  return "whatsapp_then_email";
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

function registrationCount(
  contacts: AudienceContact[],
  kind: "ever" | "selected",
) {
  return contacts.filter((contact) =>
    kind === "selected" ? contact.registeredForSelected : contact.everRegistered
  ).length;
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
    registration_url: buildRegistrationUrl({
      name,
      email: typeof contact.email === "string" ? contact.email : null,
      phone: typeof contact.phone === "string" ? contact.phone : null,
    }),
  };

  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, key: string) => {
    return values[key] ?? "";
  });
}

async function sendManualSmsRows(
  admin: any,
  rows: ManualDeliveryRow[],
  sender: string,
  automationId: string,
) {
  const results = [];

  for (const row of rows) {
    const result = await sendInfobipSms(row.recipient, row.body, { sender });
    const status = result.ok === true ? "sent" : "failed";
    const sentAt = result.ok === true ? new Date().toISOString() : null;
    const providerMessageId = result.ok === true
      ? result.providerMessageId
      : null;
    const providerStatus = result.ok === true
      ? result.providerStatus ?? null
      : null;
    const errorCode = result.ok === true ? null : result.errorCode;
    const errorMessage = result.ok === true ? null : result.errorMessage;
    const debugDetails = result.ok === true
      ? null
      : result.debugDetails ?? null;

    await admin
      .schema("invitation")
      .from("message_queue")
      .update({
        status,
        provider: "infobip",
        provider_message_id: providerMessageId,
        attempts: 1,
        last_error: errorMessage,
        sent_at: sentAt,
      })
      .eq("id", row.id);

    await admin
      .schema("invitation")
      .from("message_logs")
      .insert({
        contact_id: row.contact_id,
        automation_id: automationId,
        channel: "sms",
        provider: "infobip",
        status,
        provider_message_id: providerMessageId,
        error_code: errorCode,
        error_message: errorMessage,
        sent_at: sentAt,
        metadata: {
          queue_id: row.id,
          mode: "manual_send",
          debug_details: debugDetails,
          provider_status: providerStatus,
        },
      });

    results.push({
      id: row.id,
      ok: result.ok,
      providerMessageId,
      providerStatus,
      errorCode,
      errorMessage,
      debugDetails,
    });
  }

  return {
    ok: results.every((item) => item.ok),
    processed: results.length,
    results,
  };
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
      const smsEligibility = smsRecipientEligibility(normalizedPhone);
      const registeredForSelected = selectedEvent.has(contact.id);
      const everRegistered = ever.has(contact.id);
      const previouslyRegisteredNotSelected = everRegistered &&
        !registeredForSelected;
      const matches = audienceMatches(audienceType, {
        registeredForSelected,
        everRegistered,
      });

      return {
        ...contact,
        normalizedPhone,
        registeredForSelected,
        everRegistered,
        previouslyRegisteredNotSelected,
        matches,
        eligible: Boolean(
          normalizedPhone && contact.active && contact.sms_enabled &&
            smsEligibility.allowed,
        ),
        smsEligible: Boolean(
          normalizedPhone && contact.active && contact.sms_enabled &&
            smsEligibility.allowed,
        ),
        whatsappEligible: Boolean(
          normalizedPhone && contact.active && contact.sms_enabled &&
            smsEligibility.allowed,
        ),
        emailEligible: Boolean(
          contact.active && contact.email_enabled &&
            isValidEmail(contact.email),
        ),
        testModeBlocked: smsEligibility.testMode && !smsEligibility.allowed,
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
        totalRegistrations: registrationCount(contacts, "ever"),
        selectedEventRegistrations: registrationCount(contacts, "selected"),
        matching: contacts.filter((contact: AudienceContact) =>
          contact.matches
        ).length,
        eligible: contacts.filter((contact: AudienceContact) =>
          contact.matches && contact.eligible
        ).length,
      });
    }

    if (action === "list_campaigns") {
      await updateSmsCampaignStatuses(admin);
      const { data, error } = await admin
        .schema("invitation")
        .from("sms_campaigns")
        .select(
          "id,automation_id,audience_type,sender,message,scheduled_for,status,queued_count,sent_count,failed_count,last_error,created_at,event:party_events(id,event_date,title,starts_at,status)",
        )
        .in("status", ["queued", "dispatching", "partial", "failed"])
        .order("scheduled_for", { ascending: true })
        .limit(100);

      if (error) throw new Error("Campaigns load failed");
      return json(req, { success: true, campaigns: data ?? [] });
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
      const sender = normalizeSmsSender(body.sender);
      if (!phone || !message) {
        return json(req, {
          success: false,
          error: "Phone and message are required",
        }, 400);
      }
      if (!sender) {
        return json(req, {
          success: false,
          error: "SMS sender must be 1-11 letters/numbers",
        }, 400);
      }

      const result = await sendInfobipSms(phone, message, { sender });
      const didSend = result.ok === true;
      return json(req, {
        success: didSend,
        status: didSend ? "sent" : "failed",
        provider: "infobip",
        providerMessageId: didSend ? result.providerMessageId : null,
        providerStatus: didSend ? result.providerStatus ?? null : null,
        errorCode: didSend ? null : result.errorCode,
        errorMessage: didSend ? null : result.errorMessage,
        debugDetails: didSend ? null : result.debugDetails ?? null,
      }, didSend ? 200 : 502);
    }

    if (action === "manual_send") {
      const event = await getOrCreateEvent(admin, body);
      const audienceType = body.audienceType ?? "all_with_phone";
      const selectedIds = new Set(cleanUuidList(body.selectedContactIds));
      const channels = cleanChannels(body.channels);
      const message = cleanText(body.message, 1000);
      const name = cleanText(body.name, 120) ?? "Manual message";
      const subject = cleanText(body.subject, 180) ?? "New Level Youth";
      const sender = normalizeSmsSender(body.sender);
      const scheduledFor = body.sendNow
        ? new Date().toISOString()
        : cleanText(body.scheduledFor, 40);

      if (!selectedIds.size) {
        return json(req, {
          success: false,
          error: "Select at least one recipient",
        }, 400);
      }
      if (!channels.length) {
        return json(req, {
          success: false,
          error: "Select at least one channel",
        }, 400);
      }
      if (!message) {
        return json(req, { success: false, error: "Message is required" }, 400);
      }
      if (channels.includes("sms") && !sender) {
        return json(req, {
          success: false,
          error: "SMS sender must be 1-11 letters/numbers",
        }, 400);
      }
      if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) {
        return json(req, {
          success: false,
          error: "Scheduled time is required",
        }, 400);
      }

      const contacts = await loadAudience(admin, event.id, audienceType);
      const recipients = contacts
        .filter((contact: AudienceContact) => selectedIds.has(contact.id))
        .filter((contact: AudienceContact) =>
          (channels.includes("sms") && contact.smsEligible) ||
          (channels.includes("whatsapp") && contact.whatsappEligible) ||
          (channels.includes("email") && contact.emailEligible)
        );

      if (!recipients.length) {
        return json(
          req,
          {
            success: false,
            error: "No eligible recipients for selected channels",
          },
          400,
        );
      }

      const automationId = `manual-sms-${crypto.randomUUID()}`;
      const { data: batch, error: batchError } = await admin
        .schema("invitation")
        .from("message_batches")
        .insert({
          event_id: event.id,
          kind: "custom",
          channel_strategy: channelStrategy(channels),
          created_by: null,
        })
        .select("id")
        .single();

      if (batchError || !batch) throw new Error("Batch create failed");

      const queuedAt = new Date(scheduledFor).toISOString();
      const rows = recipients.flatMap((contact: AudienceContact) => {
        const bodyText = renderMessage(message, contact, event);
        const baseRow = {
          batch_id: batch.id,
          event_id: null,
          contact_id: contact.id,
          automation_id: automationId,
          body: bodyText,
          status: "queued",
          scheduled_for: queuedAt,
        };
        const contactRows = [];

        if (channels.includes("sms") && contact.smsEligible) {
          contactRows.push({
            ...baseRow,
            channel: "sms",
            recipient: contact.normalizedPhone,
            template_name: sender,
            subject: name,
          });
        }
        if (channels.includes("whatsapp") && contact.whatsappEligible) {
          contactRows.push({
            ...baseRow,
            channel: "whatsapp",
            recipient: contact.normalizedPhone,
            template_name: null,
            subject: name,
          });
        }
        if (channels.includes("email") && contact.emailEligible) {
          contactRows.push({
            ...baseRow,
            channel: "email",
            recipient: contact.email,
            template_name: null,
            subject,
          });
        }

        return contactRows;
      });

      if (!rows.length) {
        return json(
          req,
          {
            success: false,
            error: "No sendable messages for selected channels",
          },
          400,
        );
      }

      const { data: insertedRows, error: queueError } = await admin
        .schema("invitation")
        .from("message_queue")
        .insert(rows)
        .select("id,contact_id,channel,recipient,body");

      if (queueError || !insertedRows) {
        throw new Error(
          queueError?.message
            ? `Queue insert failed: ${queueError.message}`
            : "Queue insert failed",
        );
      }

      if (!body.sendNow) {
        return json(req, {
          success: true,
          mode: "manual_scheduled",
          automationId,
          queued: insertedRows.length,
          channels,
          scheduledFor: queuedAt,
        });
      }

      const processed = await dispatchDueMessages(
        admin,
        Math.min(insertedRows.length, 50),
        { automationId },
      );

      return json(req, {
        success: processed.ok,
        mode: "manual_now",
        automationId,
        queued: insertedRows.length,
        channels,
        processed,
      }, processed.ok ? 200 : 500);
    }

    if (action === "create_campaign") {
      const event = await getOrCreateEvent(admin, body);
      const audienceType = body.audienceType ?? "all_with_phone";
      const selectedIds = new Set(cleanUuidList(body.selectedContactIds));
      const message = cleanText(body.message, 1000);
      const name = cleanText(body.name, 120) ?? "New Level SMS";
      const sender = normalizeSmsSender(body.sender);
      const scheduledFor = body.sendNow
        ? new Date().toISOString()
        : cleanText(body.scheduledFor, 40);

      if (!message) {
        return json(req, { success: false, error: "Message is required" }, 400);
      }
      if (!sender) {
        return json(req, {
          success: false,
          error: "SMS sender must be 1-11 letters/numbers",
        }, 400);
      }
      if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) {
        return json(req, {
          success: false,
          error: "Scheduled time is required",
        }, 400);
      }

      const automationId =
        `admin-sms-${event.event_date}-${audienceType}-${crypto.randomUUID()}`;

      if (!body.sendNow) {
        if (audienceType === "custom_selection") {
          return json(req, {
            success: false,
            error: "Scheduled campaigns need a dynamic audience type",
          }, 400);
        }

        const { data: campaign, error: campaignError } = await admin
          .schema("invitation")
          .from("sms_campaigns")
          .insert({
            event_id: event.id,
            automation_id: automationId,
            audience_type: audienceType,
            sender,
            message,
            scheduled_for: new Date(scheduledFor).toISOString(),
            status: "queued",
          })
          .select(
            "id,automation_id,audience_type,sender,message,scheduled_for,status,queued_count,sent_count,failed_count,last_error,created_at,event:party_events(id,event_date,title,starts_at,status)",
          )
          .single();

        if (campaignError || !campaign) {
          throw new Error("Campaign create failed");
        }

        return json(req, {
          success: true,
          campaign,
          queued: 0,
          dynamic: true,
        });
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
        event_id: null,
        contact_id: contact.id,
        automation_id: automationId,
        channel: "sms",
        recipient: contact.normalizedPhone,
        body: renderMessage(message, contact, event),
        template_name: sender,
        scheduled_for: new Date(scheduledFor).toISOString(),
        subject: name,
      }));

      const { error: queueError } = await admin
        .schema("invitation")
        .from("message_queue")
        .insert(rows);

      if (queueError) {
        throw new Error(
          queueError.message
            ? `Queue insert failed: ${queueError.message}`
            : "Queue insert failed",
        );
      }

      let processed = null;
      if (body.sendNow) {
        processed = await dispatchDueMessages(
          admin,
          Math.min(rows.length, 50),
          { automationId },
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
        .order("created_at", { ascending: false })
        .limit(Math.min(Number(body.limit ?? 100), 300));

      if (error) throw new Error("History load failed");
      const messages = data ?? [];
      const messageIds = messages
        .filter((message: { channel?: string | null }) =>
          message.channel === "sms"
        )
        .map((message: { provider_message_id?: string | null }) =>
          message.provider_message_id ?? ""
        )
        .filter(Boolean);
      const logsResult = await getInfobipSmsLogs(messageIds);
      const logsById = new Map(
        logsResult.ok ? logsResult.logs.map((log) => [log.messageId, log]) : [],
      );
      const enrichedMessages = messages.map((
        message: { provider_message_id?: string | null },
      ) => {
        const log = message.provider_message_id
          ? logsById.get(message.provider_message_id)
          : null;
        return {
          ...message,
          delivery_status: log?.statusName ?? null,
          delivery_status_group: log?.statusGroup ?? null,
          delivery_description: log?.statusDescription ?? null,
          delivery_error: log?.errorName ?? null,
          delivery_error_group: log?.errorGroup ?? null,
          delivery_error_description: log?.errorDescription ?? null,
          delivery_done_at: log?.doneAt ?? null,
          delivery_sms_count: log?.smsCount ?? null,
          delivery_lookup_error: logsResult.ok ? null : logsResult.errorMessage,
        };
      });

      return json(req, { success: true, messages: enrichedMessages });
    }

    if (action === "update_campaign") {
      const campaignId = cleanUuid(body.campaignId);
      const event = await getOrCreateEvent(admin, body);
      const audienceType = body.audienceType ?? "all_with_phone";
      const message = cleanText(body.message, 1000);
      const sender = normalizeSmsSender(body.sender);
      const scheduledFor = cleanText(body.scheduledFor, 40);

      if (!campaignId) {
        return json(
          req,
          { success: false, error: "Campaign id is required" },
          400,
        );
      }
      if (audienceType === "custom_selection") {
        return json(req, {
          success: false,
          error: "Campaign needs a dynamic audience type",
        }, 400);
      }
      if (!message) {
        return json(req, { success: false, error: "Message is required" }, 400);
      }
      if (!sender) {
        return json(req, {
          success: false,
          error: "SMS sender must be 1-11 letters/numbers",
        }, 400);
      }
      if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) {
        return json(req, {
          success: false,
          error: "Scheduled time is required",
        }, 400);
      }

      const { data: campaign, error } = await admin
        .schema("invitation")
        .from("sms_campaigns")
        .update({
          event_id: event.id,
          audience_type: audienceType,
          sender,
          message,
          scheduled_for: new Date(scheduledFor).toISOString(),
          last_error: null,
        })
        .eq("id", campaignId)
        .eq("status", "queued")
        .select(
          "id,automation_id,audience_type,sender,message,scheduled_for,status,queued_count,sent_count,failed_count,last_error,created_at,event:party_events(id,event_date,title,starts_at,status)",
        )
        .maybeSingle();

      if (error) throw new Error("Campaign update failed");
      if (!campaign) {
        return json(req, {
          success: false,
          error: "Campaign can no longer be edited",
        }, 400);
      }

      return json(req, { success: true, campaign });
    }

    if (action === "cancel_campaign") {
      const campaignId = cleanUuid(body.campaignId);
      if (!campaignId) {
        return json(
          req,
          { success: false, error: "Campaign id is required" },
          400,
        );
      }

      const { data: campaign, error } = await admin
        .schema("invitation")
        .from("sms_campaigns")
        .update({ status: "cancelled" })
        .eq("id", campaignId)
        .in("status", ["queued", "dispatching"])
        .select("automation_id")
        .maybeSingle();

      if (error) throw new Error("Campaign cancel failed");
      if (campaign?.automation_id) {
        await admin
          .schema("invitation")
          .from("message_queue")
          .update({ status: "cancelled" })
          .eq("automation_id", campaign.automation_id)
          .in("status", ["queued", "processing"]);
      }

      return json(req, { success: true });
    }

    if (action === "process_due") {
      const limit = Math.max(1, Math.min(Number(body.limit ?? 20), 50));
      await materializeDueSmsCampaigns(admin, 10);
      const result = await dispatchDueMessages(admin, limit);
      await updateSmsCampaignStatuses(admin);
      return json(req, { success: result.ok, result }, result.ok ? 200 : 500);
    }

    return json(req, { success: false, error: "Unknown action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMS admin failed";
    return json(req, { success: false, error: message }, 500);
  }
});
