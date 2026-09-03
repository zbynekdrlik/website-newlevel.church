import {
  normalizeE164,
  normalizeSmsSender,
  smsRecipientEligibility,
} from "./infobip.ts";
import { renderContactTemplate } from "./message_template.ts";
import { audienceMatches, type AudienceType } from "./audience.ts";

export type SmsAudienceType = Exclude<AudienceType, "custom_selection">;

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

export type AudienceContact = ContactRow & {
  normalizedPhone: string | null;
  registeredForSelected: boolean;
  everRegistered: boolean;
  previouslyRegisteredNotSelected: boolean;
  matches: boolean;
  eligible: boolean;
  testModeBlocked: boolean;
};

type SmsCampaignRow = {
  id: string;
  event_id: string;
  automation_id: string;
  audience_type: SmsAudienceType;
  sender: string;
  message: string;
  scheduled_for: string;
  status: string;
};

export function nextFridayDate() {
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

export const renderSmsMessage = renderContactTemplate;

export async function getOrCreateSmsEvent(admin: any, value: {
  eventId?: string | null;
  eventDate?: string | null;
}) {
  if (value.eventId && /^[0-9a-f-]{36}$/i.test(value.eventId)) {
    const { data, error } = await admin
      .schema("invitation")
      .from("party_events")
      .select("id,event_date,title,starts_at,status")
      .eq("id", value.eventId)
      .maybeSingle();
    if (error) throw new Error("Event load failed");
    if (data) return data;
  }

  const eventDate = value.eventDate?.trim() || nextFridayDate();
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

export async function loadSmsAudience(
  admin: any,
  eventId: string,
  audienceType: SmsAudienceType | "custom_selection",
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
        testModeBlocked: smsEligibility.testMode && !smsEligibility.allowed,
      };
    },
  );
}

async function loadEventById(admin: any, eventId: string) {
  const { data, error } = await admin
    .schema("invitation")
    .from("party_events")
    .select("id,event_date,title,starts_at,status")
    .eq("id", eventId)
    .maybeSingle();

  if (error || !data) throw new Error("Campaign event load failed");
  return data;
}

export async function materializeSmsCampaign(
  admin: any,
  campaign: SmsCampaignRow,
) {
  const { error: lockError } = await admin
    .schema("invitation")
    .from("sms_campaigns")
    .update({ status: "dispatching", last_error: null })
    .eq("id", campaign.id)
    .eq("status", "queued");

  if (lockError) throw new Error(`Campaign lock failed: ${lockError.message}`);

  const event = await loadEventById(admin, campaign.event_id);
  const contacts = await loadSmsAudience(
    admin,
    campaign.event_id,
    campaign.audience_type,
  );
  const recipients = contacts.filter((contact) =>
    contact.matches && contact.eligible
  );

  if (!recipients.length) {
    await admin
      .schema("invitation")
      .from("sms_campaigns")
      .update({
        status: "failed",
        queued_count: 0,
        sent_count: 0,
        failed_count: 0,
        last_error: "No eligible recipients at scheduled time",
      })
      .eq("id", campaign.id);
    return { campaignId: campaign.id, queued: 0 };
  }

  const { data: batch, error: batchError } = await admin
    .schema("invitation")
    .from("message_batches")
    .insert({
      event_id: campaign.event_id,
      kind: "custom",
      channel_strategy: "sms_only",
      created_by: null,
    })
    .select("id")
    .single();

  if (batchError || !batch) throw new Error("Batch create failed");

  const sender = normalizeSmsSender(campaign.sender) ?? "NewLevel";
  const rows = recipients.map((contact: AudienceContact) => ({
    batch_id: batch.id,
    event_id: null,
    contact_id: contact.id,
    automation_id: campaign.automation_id,
    channel: "sms",
    recipient: contact.normalizedPhone,
    body: renderSmsMessage(
      campaign.message,
      contact,
      event,
      campaign.scheduled_for,
    ),
    template_name: sender,
    scheduled_for: new Date(campaign.scheduled_for).toISOString(),
    subject: "New Level SMS",
  }));

  const { error: queueError } = await admin
    .schema("invitation")
    .from("message_queue")
    .upsert(rows, {
      onConflict: "automation_id,contact_id,channel",
      ignoreDuplicates: true,
    });

  if (queueError) throw new Error(`Queue insert failed: ${queueError.message}`);

  await admin
    .schema("invitation")
    .from("sms_campaigns")
    .update({ queued_count: rows.length, last_error: null })
    .eq("id", campaign.id);

  return { campaignId: campaign.id, queued: rows.length };
}

export async function materializeDueSmsCampaigns(admin: any, limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit ?? 10), 20));
  const { data: campaigns, error } = await admin
    .schema("invitation")
    .from("sms_campaigns")
    .select(
      "id,event_id,automation_id,audience_type,sender,message,scheduled_for,status",
    )
    .eq("status", "queued")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(safeLimit);

  if (error || !campaigns) {
    return {
      ok: false as const,
      error: error?.message ?? "Campaign load failed",
    };
  }

  const results = [];
  for (const campaign of campaigns as SmsCampaignRow[]) {
    try {
      results.push(await materializeSmsCampaign(admin, campaign));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await admin
        .schema("invitation")
        .from("sms_campaigns")
        .update({ status: "failed", last_error: message.slice(0, 500) })
        .eq("id", campaign.id);
      results.push({ campaignId: campaign.id, queued: 0, error: message });
    }
  }

  return { ok: true as const, results };
}

export async function updateSmsCampaignStatuses(admin: any) {
  const { data: campaigns, error } = await admin
    .schema("invitation")
    .from("sms_campaigns")
    .select("id,automation_id,status")
    .eq("status", "dispatching")
    .limit(100);

  if (error || !campaigns) return;

  for (
    const campaign of campaigns as Pick<
      SmsCampaignRow,
      "id" | "automation_id"
    >[]
  ) {
    const { data: queueRows } = await admin
      .schema("invitation")
      .from("message_queue")
      .select("status")
      .eq("automation_id", campaign.automation_id);

    const rows = (queueRows ?? []) as { status: string }[];
    if (!rows.length) continue;

    const sent = rows.filter((row) => row.status === "sent").length;
    const failed = rows.filter((row) => row.status === "failed").length;
    const pending = rows.filter((row) =>
      row.status === "queued" || row.status === "processing"
    ).length;

    const status = pending > 0
      ? "dispatching"
      : sent > 0 && failed > 0
      ? "partial"
      : sent > 0
      ? "sent"
      : "failed";

    await admin
      .schema("invitation")
      .from("sms_campaigns")
      .update({
        status,
        queued_count: rows.length,
        sent_count: sent,
        failed_count: failed,
      })
      .eq("id", campaign.id);
  }
}
