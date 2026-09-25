import {
  corsHeaders,
  createAdminClient,
  json,
  readJsonBody,
  readServiceKey,
  validateRequestBasics,
} from "../_shared/contact.ts";

type Member = {
  id: string;
  name: string;
  email: string | null;
  discord_user_id: string | null;
  active: boolean;
};

type Shift = {
  id: string;
  service_date: string;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  published_at: string | null;
};

type Assignment = {
  id: string;
  shift_id: string;
  member_id: string;
  position: number;
  status: "pending" | "confirmed" | "declined" | "replaced";
  source: "automatic" | "manual" | "discord" | "portal";
};

type DiscordWebhookConfig = {
  url: string;
  threadId: string;
};

type NotificationKind = "monthly_schedule" | "shift_reminder";

const ACTIVE_STATUSES = ["pending", "confirmed"];
const SHIFT_POSITIONS = [1] as const;
const MEMBER_PORTAL_URL = "https://newlevel.church/riad";

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(
      atob(padded),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function uuidToBytes(value: string) {
  const hex = value.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/.{2}/g)!, (byte) => parseInt(byte, 16));
}

function bytesToUuid(bytes: Uint8Array) {
  if (bytes.length !== 16) return null;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

async function memberTokenSignature(memberId: string) {
  const secret = Deno.env.get("DISHWASHER_MEMBER_LINK_SECRET")?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error("Osobné odkazy nie sú nakonfigurované");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(memberId),
  );
  return new Uint8Array(signature).slice(0, 18);
}

async function memberPortalToken(memberId: string) {
  const idBytes = uuidToBytes(memberId);
  if (!idBytes) throw new Error("Neplatný identifikátor človeka");
  const signature = await memberTokenSignature(memberId);
  return `${bytesToBase64Url(idBytes)}.${bytesToBase64Url(signature)}`;
}

async function memberIdFromPortalToken(value: unknown) {
  const token = cleanText(value, 80);
  if (!token) return null;
  const [encodedId, encodedSignature, extra] = token.split(".");
  if (!encodedId || !encodedSignature || extra) return null;
  const idBytes = base64UrlToBytes(encodedId);
  const suppliedSignature = base64UrlToBytes(encodedSignature);
  if (!idBytes || !suppliedSignature) return null;
  const memberId = bytesToUuid(idBytes);
  if (!memberId) return null;
  const expectedSignature = await memberTokenSignature(memberId);
  if (suppliedSignature.length !== expectedSignature.length) return null;
  let difference = 0;
  for (let index = 0; index < expectedSignature.length; index += 1) {
    difference |= expectedSignature[index] ^ suppliedSignature[index];
  }
  return difference === 0 ? memberId : null;
}

async function memberPortalUrl(memberId: string) {
  const configured = Deno.env.get("DISHWASHER_MEMBER_PORTAL_URL")?.trim();
  const baseUrl = configured || MEMBER_PORTAL_URL;
  const url = new URL(baseUrl);
  url.searchParams.set("t", await memberPortalToken(memberId));
  return url.toString();
}

function timingSafeEqual(leftValue: string, rightValue: string) {
  const encoder = new TextEncoder();
  const left = encoder.encode(leftValue);
  const right = encoder.encode(rightValue);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function requireCron(req: Request) {
  const expected = Deno.env.get("CRON_SECRET")?.trim() ?? "";
  const supplied = req.headers.get("x-cron-secret")?.trim() ?? "";
  return Boolean(expected && supplied && timingSafeEqual(expected, supplied));
}

function requireStaff(req: Request) {
  const expected = Deno.env.get("DISHWASHER_STAFF_KEY")?.trim() ?? "";
  const supplied = req.headers.get("x-staff-key")?.trim() ?? "";
  return Boolean(expected && supplied && timingSafeEqual(expected, supplied));
}

function monthBounds(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    return null;
  }
  const [year, month] = value.split("-").map(Number);
  const start = `${value}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = endDate.toISOString().slice(0, 10);
  return { month: value, start, end, year, monthNumber: month };
}

function serviceDates(year: number, month: number) {
  const result: string[] = [];
  const cursor = new Date(Date.UTC(year, month - 1, 1));
  while (cursor.getUTCMonth() === month - 1) {
    const day = cursor.getUTCDay();
    if (day === 4 || day === 0) result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function validEmail(value: string | null) {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validDiscordUserId(value: string | null) {
  return !value || /^\d{15,22}$/.test(value);
}

async function loadState(
  admin: any,
  bounds: NonNullable<ReturnType<typeof monthBounds>>,
) {
  const [membersResult, shiftsResult, availabilityResult] = await Promise.all([
    admin.schema("invitation").from("dishwasher_members").select("*").order(
      "name",
    ),
    admin.schema("invitation").from("dishwasher_shifts").select("*")
      .gte("service_date", bounds.start).lte("service_date", bounds.end)
      .order("service_date"),
    admin.schema("invitation").from("dishwasher_availability").select("*")
      .gte("service_date", bounds.start).lte("service_date", bounds.end),
  ]);

  const error = membersResult.error || shiftsResult.error ||
    availabilityResult.error;
  if (error) throw error;
  const shifts = (shiftsResult.data ?? []) as Shift[];
  let assignments: Assignment[] = [];
  if (shifts.length) {
    const assignmentResult = await admin.schema("invitation")
      .from("dishwasher_assignments").select("*")
      .in("shift_id", shifts.map((shift) => shift.id))
      .in("status", ACTIVE_STATUSES)
      .order("position");
    if (assignmentResult.error) throw assignmentResult.error;
    assignments = assignmentResult.data ?? [];
  }

  const botConfigured = Boolean(
    Deno.env.get("DISCORD_DISHWASHER_BOT_TOKEN")?.trim() &&
      Deno.env.get("DISCORD_DISHWASHER_PUBLIC_KEY")?.trim() &&
      Deno.env.get("DISCORD_DISHWASHER_CHANNEL_ID")?.trim(),
  );
  const webhookConfigured = Boolean(discordWebhookConfig());

  return {
    members: membersResult.data ?? [],
    shifts,
    availability: availabilityResult.data ?? [],
    assignments,
    integrations: {
      discordConfigured: botConfigured || webhookConfigured,
      discordMode: webhookConfigured
        ? "webhook"
        : botConfigured
        ? "bot"
        : "none",
    },
  };
}

async function ensureShifts(
  admin: any,
  bounds: NonNullable<ReturnType<typeof monthBounds>>,
) {
  const rows = serviceDates(bounds.year, bounds.monthNumber).map((
    service_date,
  ) => ({ service_date }));
  const { error } = await admin.schema("invitation").from("dishwasher_shifts")
    .upsert(rows, { onConflict: "service_date", ignoreDuplicates: true });
  if (error) throw error;
}

async function assignmentHistory(
  admin: any,
  members: Member[],
  throughDate: string,
) {
  const earliest = new Date(`${throughDate}T12:00:00Z`);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - 1);
  const shiftsResult = await admin.schema("invitation").from(
    "dishwasher_shifts",
  )
    .select("id,service_date")
    .gte("service_date", earliest.toISOString().slice(0, 10))
    .lte("service_date", throughDate);
  if (shiftsResult.error) throw shiftsResult.error;
  const dates = new Map<string, string>(
    (shiftsResult.data ?? []).map((
      shift: Shift,
    ) => [shift.id, shift.service_date]),
  );
  const counts = new Map(members.map((member) => [member.id, 0]));
  const lastDates = new Map(members.map((member) => [member.id, ""]));
  if (!dates.size) return { counts, lastDates };

  const result = await admin.schema("invitation").from("dishwasher_assignments")
    .select("shift_id,member_id,status").in("shift_id", [...dates.keys()])
    .in("status", ACTIVE_STATUSES);
  if (result.error) throw result.error;
  for (const assignment of result.data ?? []) {
    const date = dates.get(assignment.shift_id) ?? "";
    counts.set(
      assignment.member_id,
      (counts.get(assignment.member_id) ?? 0) + 1,
    );
    if (date > (lastDates.get(assignment.member_id) ?? "")) {
      lastDates.set(assignment.member_id, date);
    }
  }
  return { counts, lastDates };
}

async function fillOpenPositions(
  admin: any,
  bounds: NonNullable<ReturnType<typeof monthBounds>>,
  fromDate = bounds.start,
) {
  const state = await loadState(admin, bounds);
  const members = (state.members as Member[]).filter((member) => member.active);
  if (!members.length) {
    return { added: 0, unfilled: state.shifts.length * SHIFT_POSITIONS.length };
  }

  const unavailable = new Set(
    state.availability.filter((row: any) => row.available === false)
      .map((row: any) => `${row.member_id}:${row.service_date}`),
  );
  const activeAssignments = [...state.assignments] as Assignment[];
  const history = await assignmentHistory(admin, members, bounds.end);
  let added = 0;
  let unfilled = 0;

  for (const shift of state.shifts as Shift[]) {
    if (shift.service_date < fromDate) continue;
    for (const position of SHIFT_POSITIONS) {
      if (
        activeAssignments.some((assignment) =>
          assignment.shift_id === shift.id && assignment.position === position
        )
      ) continue;
      const alreadyAssigned = new Set(
        activeAssignments.filter((assignment) =>
          assignment.shift_id === shift.id
        ).map((assignment) => assignment.member_id),
      );
      const candidates = members.filter((member) =>
        !alreadyAssigned.has(member.id) &&
        !unavailable.has(`${member.id}:${shift.service_date}`)
      ).sort((left, right) => {
        const countDifference = (history.counts.get(left.id) ?? 0) -
          (history.counts.get(right.id) ?? 0);
        if (countDifference) return countDifference;
        const dateDifference = (history.lastDates.get(left.id) ?? "")
          .localeCompare(history.lastDates.get(right.id) ?? "");
        if (dateDifference) return dateDifference;
        return left.name.localeCompare(right.name, "sk");
      });
      const selected = candidates[0];
      if (!selected) {
        unfilled += 1;
        continue;
      }
      const insertResult = await admin.schema("invitation").from(
        "dishwasher_assignments",
      )
        .insert({
          shift_id: shift.id,
          member_id: selected.id,
          position,
          status: "pending",
          source: "automatic",
        })
        .select("*").single();
      if (insertResult.error) throw insertResult.error;
      activeAssignments.push(insertResult.data);
      history.counts.set(
        selected.id,
        (history.counts.get(selected.id) ?? 0) + 1,
      );
      history.lastDates.set(selected.id, shift.service_date);
      added += 1;
    }
  }
  return { added, unfilled };
}

function slovakDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  const formatted = new Intl.DateTimeFormat("sk-SK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Bratislava",
  }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function slovakShortDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  const formatted = new Intl.DateTimeFormat("sk-SK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Bratislava",
  }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function bratislavaNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bratislava",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    day: Number(value("day")),
    hour: Number(value("hour")),
  };
}

function addCalendarDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function portalLinks(
  assignments: Assignment[],
  members: Member[],
) {
  const activeMemberIds = [
    ...new Set(
      assignments.filter((assignment) =>
        ACTIVE_STATUSES.includes(assignment.status)
      ).map((assignment) => assignment.member_id),
    ),
  ];
  const links = new Map<string, string>();
  await Promise.all(activeMemberIds.map(async (memberId) => {
    links.set(memberId, await memberPortalUrl(memberId));
  }));
  return links;
}

async function discordShiftPayload(
  shift: Shift,
  assignments: Assignment[],
  members: Member[],
  interactive = true,
) {
  const byId = new Map(members.map((member) => [member.id, member]));
  const active = assignments.filter((assignment) =>
    assignment.shift_id === shift.id &&
    assignment.position === SHIFT_POSITIONS[0] &&
    ACTIVE_STATUSES.includes(assignment.status)
  );
  const links = await portalLinks(active, members);
  const fields = SHIFT_POSITIONS.map((position) => {
    const assignment = active.find((item) => item.position === position);
    const member = assignment ? byId.get(assignment.member_id) : null;
    const status = assignment?.status === "confirmed"
      ? "✅ potvrdené"
      : assignment
      ? interactive ? "⏳ čaká na potvrdenie" : "📌 pridelené"
      : "⚠️ voľné miesto";
    return {
      name: "Služobník",
      value: member
        ? `**${member.name}**\n${status}\n[Pozrieť môj rozpis](${
          links.get(member.id)
        })`
        : status,
      inline: true,
    };
  });
  const buttons = active.flatMap((assignment) => {
    const member = byId.get(assignment.member_id);
    if (!member) return [];
    const firstName = member.name.split(/\s+/)[0];
    if (assignment.status === "confirmed") {
      return [{
        type: 2,
        style: 4,
        label: `Predsa nemôžem · ${firstName}`,
        custom_id: `dish:${assignment.id}:no`,
      }];
    }
    return [
      {
        type: 2,
        style: 3,
        label: `Môžem · ${firstName}`,
        custom_id: `dish:${assignment.id}:yes`,
      },
      {
        type: 2,
        style: 4,
        label: `Nemôžem · ${firstName}`,
        custom_id: `dish:${assignment.id}:no`,
      },
    ];
  });
  const mentionIds = active.map((assignment) =>
    byId.get(assignment.member_id)?.discord_user_id
  ).filter(Boolean) as string[];
  return {
    content: mentionIds.map((id) => `<@${id}>`).join(" ") || undefined,
    allowed_mentions: { users: mentionIds },
    embeds: [{
      title: `🍽️ Umývanie riadu · ${slovakDate(shift.service_date)}`,
      color: active.some((assignment) => assignment.status !== "confirmed")
        ? 0xf0b429
        : 0x2eae6b,
      fields,
      footer: {
        text: interactive
          ? "Pridelený človek potvrdí svoju možnosť nižšie."
          : "Na osobnej stránke potvrď, či môžeš slúžiť.",
      },
    }],
    ...(interactive && buttons.length
      ? { components: [{ type: 1, components: buttons.slice(0, 5) }] }
      : {}),
  };
}

function discordWebhookConfig(): DiscordWebhookConfig | null {
  const url = Deno.env.get("DISCORD_DISHWASHER_WEBHOOK_URL")?.trim() ?? "";
  const threadId = Deno.env.get("DISCORD_DISHWASHER_THREAD_ID")?.trim() ?? "";
  if (!/^\d{15,22}$/.test(threadId)) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !["discord.com", "discordapp.com"].includes(parsed.hostname) ||
      !/^\/api\/webhooks\/\d{15,22}\/[A-Za-z0-9._-]+\/?$/.test(parsed.pathname)
    ) return null;
    return { url: parsed.toString().replace(/\/$/, ""), threadId };
  } catch {
    return null;
  }
}

async function discordRequest(path: string, init: RequestInit) {
  const token = Deno.env.get("DISCORD_DISHWASHER_BOT_TOKEN")?.trim();
  if (!token) throw new Error("Discord bot nie je nakonfigurovaný");
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Discord API zlyhalo (${response.status})`);
  return await response.json().catch(() => ({}));
}

async function discordWebhookRequest(
  config: DiscordWebhookConfig,
  path: string,
  init: RequestInit,
) {
  const url = new URL(`${config.url}${path}`);
  url.searchParams.set("thread_id", config.threadId);
  if (init.method === "POST") url.searchParams.set("wait", "true");
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Discord webhook zlyhal (${response.status})`);
  }
  return await response.json().catch(() => ({}));
}

async function deleteDiscordWebhookMessage(
  config: DiscordWebhookConfig,
  messageId: string,
) {
  const url = new URL(`${config.url}/messages/${messageId}`);
  url.searchParams.set("thread_id", config.threadId);
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Discord webhook zlyhal (${response.status})`);
  }
}

async function replaceDiscordWebhookMessage(
  config: DiscordWebhookConfig,
  previousMessageId: string,
  payload: Record<string, unknown>,
) {
  const message = await discordWebhookRequest(config, "", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  await deleteDiscordWebhookMessage(config, previousMessageId);
  return String(message.id ?? "");
}

async function monthlySchedulePayload(
  month: string,
  shifts: Shift[],
  assignments: Assignment[],
  members: Member[],
) {
  const byId = new Map(members.map((member) => [member.id, member]));
  const active = assignments.filter((assignment) =>
    assignment.position === SHIFT_POSITIONS[0] &&
    ACTIVE_STATUSES.includes(assignment.status)
  );
  const links = await portalLinks(active, members);
  const mentionIds = [
    ...new Set(
      active.map((assignment) =>
        byId.get(assignment.member_id)?.discord_user_id
      ).filter(Boolean) as string[],
    ),
  ];
  const lines = shifts.map((shift) => {
    const names = SHIFT_POSITIONS.map((position) => {
      const assignment = active.find((item) =>
        item.shift_id === shift.id && item.position === position
      );
      if (!assignment) return "*voľné miesto*";
      const member = byId.get(assignment.member_id);
      if (!member) return "*neznámy človek*";
      return member.discord_user_id
        ? `<@${member.discord_user_id}>`
        : `**${member.name}**`;
    });
    return `**${slovakShortDate(shift.service_date)}** — ${names.join(", ")}`;
  });
  const monthName = new Intl.DateTimeFormat("sk-SK", {
    month: "long",
    year: "numeric",
    timeZone: "Europe/Bratislava",
  }).format(new Date(`${month}-12T12:00:00Z`));
  const linkedMembers = [
    ...new Set(active.map((assignment) => assignment.member_id)),
  ].map((memberId) => byId.get(memberId)).filter(Boolean) as Member[];
  const personalLinks = linkedMembers.map((member) => {
    const label = member.discord_user_id
      ? `<@${member.discord_user_id}>`
      : `**${member.name}**`;
    return `${label} — [môj rozpis](${links.get(member.id)})`;
  });
  return {
    content: [
      `🍽️ **Rozpis služby riadu · ${monthName}**`,
      "",
      lines.join("\n") || "Tento mesiac zatiaľ nemá služby.",
    ].join("\n"),
    allowed_mentions: { parse: [], users: mentionIds },
    embeds: [{
      title: "Pozrieť a potvrdiť rozpis",
      description: personalLinks.join("\n"),
      color: 0x2eae6b,
    }],
  };
}

async function shiftReminderPayload(
  shift: Shift,
  assignments: Assignment[],
  members: Member[],
) {
  const byId = new Map(members.map((member) => [member.id, member]));
  const active = assignments.filter((assignment) =>
    assignment.shift_id === shift.id &&
    assignment.position === SHIFT_POSITIONS[0] &&
    ACTIVE_STATUSES.includes(assignment.status)
  );
  const links = await portalLinks(active, members);
  const mentionIds = [
    ...new Set(
      active.map((assignment) =>
        byId.get(assignment.member_id)?.discord_user_id
      ).filter(Boolean) as string[],
    ),
  ];
  const names = SHIFT_POSITIONS.map((position) => {
    const assignment = active.find((item) => item.position === position);
    if (!assignment) return "*voľné miesto*";
    const member = byId.get(assignment.member_id);
    if (!member) return "*neznámy človek*";
    return member.discord_user_id
      ? `<@${member.discord_user_id}>`
      : `**${member.name}**`;
  });
  const personalLinks = active.map((assignment) => {
    const member = byId.get(assignment.member_id);
    if (!member) return null;
    const label = member.discord_user_id
      ? `<@${member.discord_user_id}>`
      : `**${member.name}**`;
    return `${label} — [otvoriť môj rozpis](${links.get(member.id)})`;
  }).filter(Boolean);
  return {
    content: [
      "🔔 **Zajtrajšia služba riadu**",
      `**${slovakShortDate(shift.service_date)}**`,
      names.join(""),
      "",
      "Prosím potvrď, či môžeš slúžiť.",
    ].join("\n"),
    allowed_mentions: { parse: [], users: mentionIds },
    embeds: [{
      title: "Potvrdenie služby",
      description: personalLinks.join("\n"),
      color: 0xf0b429,
    }],
  };
}

async function claimNotification(
  admin: any,
  key: string,
  kind: NotificationKind,
  targetDate: string,
) {
  const result = await admin.schema("invitation").from(
    "dishwasher_notification_runs",
  ).insert({
    notification_key: key,
    kind,
    target_date: targetDate,
  });
  if (result.error?.code === "23505") return false;
  if (result.error) throw result.error;
  return true;
}

async function releaseNotification(admin: any, key: string) {
  await admin.schema("invitation").from("dishwasher_notification_runs")
    .delete().eq("notification_key", key).is("sent_at", null);
}

async function markNotificationSent(
  admin: any,
  key: string,
  messageId: string | null,
) {
  const result = await admin.schema("invitation").from(
    "dishwasher_notification_runs",
  ).update({
    discord_message_id: messageId,
    sent_at: new Date().toISOString(),
  }).eq("notification_key", key);
  if (result.error) throw result.error;
}

async function sendClaimedNotification(
  admin: any,
  webhook: DiscordWebhookConfig,
  key: string,
  kind: NotificationKind,
  targetDate: string,
  payload: Record<string, unknown>,
) {
  if (!(await claimNotification(admin, key, kind, targetDate))) return false;
  try {
    const message = await discordWebhookRequest(webhook, "", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await markNotificationSent(admin, key, message.id ?? null);
    return true;
  } catch (error) {
    await releaseNotification(admin, key);
    throw error;
  }
}

async function handleRosterCron(req: Request, admin: any) {
  if (req.method !== "POST") {
    return json(req, { success: false, error: "Method not allowed" }, 405);
  }
  if (!requireCron(req)) {
    return json(req, { success: false, error: "Forbidden" }, 403);
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }
  const forceMonthly = parsed.data.forceMonthly === true;
  const replaceLatestMonthly = forceMonthly &&
    parsed.data.replaceLatestMonthly === true;
  const forcedMonth = monthBounds(parsed.data.month)?.month ?? null;
  const now = bratislavaNowParts();
  if (parsed.data.generateOnly === true) {
    if (!forcedMonth) {
      return json(req, { success: false, error: "Neplatný mesiac" }, 400);
    }
    const bounds = monthBounds(forcedMonth)!;
    await ensureShifts(admin, bounds);
    const fromDate = now.date > bounds.start ? now.date : bounds.start;
    const result = await fillOpenPositions(admin, bounds, fromDate);
    return json(req, {
      success: true,
      localDate: now.date,
      month: forcedMonth,
      ...result,
    });
  }
  const webhook = discordWebhookConfig();
  if (!webhook) {
    return json(
      req,
      { success: false, error: "Discord webhook nie je nakonfigurovaný" },
      500,
    );
  }
  if (!forceMonthly && now.hour !== 9) {
    return json(req, { success: true, skipped: "outside_notification_hour" });
  }

  const sent: NotificationKind[] = [];
  if (forceMonthly || now.day === 1) {
    const month = forcedMonth ?? now.date.slice(0, 7);
    const bounds = monthBounds(month)!;
    await ensureShifts(admin, bounds);
    await fillOpenPositions(admin, bounds);
    const state = await loadState(admin, bounds);
    const payload = await monthlySchedulePayload(
      month,
      state.shifts,
      state.assignments,
      state.members,
    );
    let sentMonthly = false;
    if (replaceLatestMonthly) {
      const previous = await admin.schema("invitation").from(
        "dishwasher_notification_runs",
      ).select("*").eq("kind", "monthly_schedule").eq(
        "target_date",
        bounds.start,
      ).not("discord_message_id", "is", null).order("sent_at", {
        ascending: false,
      }).limit(1).maybeSingle();
      if (previous.error) throw previous.error;
      if (previous.data?.discord_message_id) {
        const messageId = await replaceDiscordWebhookMessage(
          webhook,
          previous.data.discord_message_id,
          payload,
        );
        const update = await admin.schema("invitation").from(
          "dishwasher_notification_runs",
        ).update({
          discord_message_id: messageId,
          sent_at: new Date().toISOString(),
        }).eq("notification_key", previous.data.notification_key);
        if (update.error) throw update.error;
        sentMonthly = true;
      }
    }
    if (!sentMonthly) {
      sentMonthly = await sendClaimedNotification(
        admin,
        webhook,
        forceMonthly
          ? `monthly-test:${month}:${crypto.randomUUID()}`
          : `monthly:${month}`,
        "monthly_schedule",
        bounds.start,
        payload,
      );
    }
    if (sentMonthly) sent.push("monthly_schedule");
  }

  if (forceMonthly) {
    return json(req, { success: true, localDate: now.date, sent });
  }

  const tomorrow = addCalendarDays(now.date, 1);
  const bounds = monthBounds(tomorrow.slice(0, 7))!;
  await ensureShifts(admin, bounds);
  await fillOpenPositions(admin, bounds, tomorrow);
  const state = await loadState(admin, bounds);
  const shift = (state.shifts as Shift[]).find((item) =>
    item.service_date === tomorrow
  );
  if (shift) {
    const sentReminder = await sendClaimedNotification(
      admin,
      webhook,
      `reminder:${tomorrow}`,
      "shift_reminder",
      tomorrow,
      await shiftReminderPayload(
        shift,
        state.assignments,
        state.members,
      ),
    );
    if (sentReminder) sent.push("shift_reminder");
  }

  return json(req, { success: true, localDate: now.date, sent });
}

async function syncDiscordShift(admin: any, shiftId: string) {
  const shiftResult = await admin.schema("invitation").from("dishwasher_shifts")
    .select("*").eq("id", shiftId).single();
  if (shiftResult.error) throw shiftResult.error;
  const shift = shiftResult.data as Shift;
  if (!shift.discord_channel_id || !shift.discord_message_id) return;
  const [assignmentsResult, membersResult] = await Promise.all([
    admin.schema("invitation").from("dishwasher_assignments").select("*").eq(
      "shift_id",
      shiftId,
    ).in("status", ACTIVE_STATUSES),
    admin.schema("invitation").from("dishwasher_members").select("*"),
  ]);
  if (assignmentsResult.error || membersResult.error) {
    throw assignmentsResult.error || membersResult.error;
  }
  const webhook = discordWebhookConfig();
  if (webhook && shift.discord_channel_id === webhook.threadId) {
    await discordWebhookRequest(
      webhook,
      `/messages/${shift.discord_message_id}`,
      {
        method: "PATCH",
        body: JSON.stringify(
          await discordShiftPayload(
            shift,
            assignmentsResult.data,
            membersResult.data,
            false,
          ),
        ),
      },
    );
    return;
  }

  await discordRequest(
    `/channels/${shift.discord_channel_id}/messages/${shift.discord_message_id}`,
    {
      method: "PATCH",
      body: JSON.stringify(
        await discordShiftPayload(
          shift,
          assignmentsResult.data,
          membersResult.data,
        ),
      ),
    },
  );
}

async function replaceDiscordMessagesForShift(admin: any, shiftId: string) {
  const webhook = discordWebhookConfig();
  if (!webhook) {
    await syncDiscordShift(admin, shiftId);
    return;
  }

  const shiftResult = await admin.schema("invitation").from(
    "dishwasher_shifts",
  ).select("*").eq("id", shiftId).single();
  if (shiftResult.error) throw shiftResult.error;
  const shift = shiftResult.data as Shift;
  const bounds = monthBounds(shift.service_date.slice(0, 7))!;
  const state = await loadState(admin, bounds);
  const assignments = state.assignments as Assignment[];
  const members = state.members as Member[];

  if (
    shift.discord_message_id && shift.discord_channel_id === webhook.threadId
  ) {
    const messageId = await replaceDiscordWebhookMessage(
      webhook,
      shift.discord_message_id,
      await discordShiftPayload(shift, assignments, members, false),
    );
    const update = await admin.schema("invitation").from("dishwasher_shifts")
      .update({
        discord_message_id: messageId,
        published_at: new Date().toISOString(),
      }).eq("id", shift.id);
    if (update.error) throw update.error;
  }

  const reminderResult = await admin.schema("invitation").from(
    "dishwasher_notification_runs",
  ).select("*").eq("notification_key", `reminder:${shift.service_date}`)
    .not("discord_message_id", "is", null).maybeSingle();
  if (reminderResult.error) throw reminderResult.error;
  if (reminderResult.data?.discord_message_id) {
    const messageId = await replaceDiscordWebhookMessage(
      webhook,
      reminderResult.data.discord_message_id,
      await shiftReminderPayload(shift, assignments, members),
    );
    const update = await admin.schema("invitation").from(
      "dishwasher_notification_runs",
    ).update({
      discord_message_id: messageId,
      sent_at: new Date().toISOString(),
    }).eq("notification_key", reminderResult.data.notification_key);
    if (update.error) throw update.error;
  }

  const monthlyResult = await admin.schema("invitation").from(
    "dishwasher_notification_runs",
  ).select("*").eq("kind", "monthly_schedule").eq(
    "target_date",
    bounds.start,
  ).not("discord_message_id", "is", null).order("sent_at", {
    ascending: false,
  }).limit(1).maybeSingle();
  if (monthlyResult.error) throw monthlyResult.error;
  if (monthlyResult.data?.discord_message_id) {
    const messageId = await replaceDiscordWebhookMessage(
      webhook,
      monthlyResult.data.discord_message_id,
      await monthlySchedulePayload(
        bounds.month,
        state.shifts,
        assignments,
        members,
      ),
    );
    const update = await admin.schema("invitation").from(
      "dishwasher_notification_runs",
    ).update({
      discord_message_id: messageId,
      sent_at: new Date().toISOString(),
    }).eq("notification_key", monthlyResult.data.notification_key);
    if (update.error) throw update.error;
  }
}

function hexBytes(value: string) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) return null;
  return new Uint8Array(
    value.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)),
  );
}

async function verifyDiscordRequest(req: Request, body: string) {
  const signature = hexBytes(req.headers.get("x-signature-ed25519") ?? "");
  const timestamp = req.headers.get("x-signature-timestamp") ?? "";
  const publicKey = hexBytes(
    Deno.env.get("DISCORD_DISHWASHER_PUBLIC_KEY")?.trim() ?? "",
  );
  if (!signature || !timestamp || !publicKey) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

function discordUserId(payload: any) {
  return payload.member?.user?.id ?? payload.user?.id ?? "";
}

async function handleDiscord(req: Request, admin: any) {
  const raw = await req.text();
  if (!(await verifyDiscordRequest(req, raw))) {
    return new Response("invalid request signature", { status: 401 });
  }
  const payload = JSON.parse(raw);
  if (payload.type === 1) return Response.json({ type: 1 });
  const match = String(payload.data?.custom_id ?? "").match(
    /^dish:([0-9a-f-]{36}):(yes|no)$/,
  );
  if (payload.type !== 3 || !match) {
    return Response.json({
      type: 4,
      data: { content: "Neznáma akcia.", flags: 64 },
    });
  }

  const [, assignmentId, answer] = match;
  const assignmentResult = await admin.schema("invitation").from(
    "dishwasher_assignments",
  )
    .select("*").eq("id", assignmentId).single();
  if (
    assignmentResult.error ||
    !ACTIVE_STATUSES.includes(assignmentResult.data.status)
  ) {
    return Response.json({
      type: 4,
      data: { content: "Toto pridelenie už nie je aktuálne.", flags: 64 },
    });
  }
  const memberResult = await admin.schema("invitation").from(
    "dishwasher_members",
  )
    .select("*").eq("id", assignmentResult.data.member_id).single();
  if (
    memberResult.error ||
    memberResult.data.discord_user_id !== discordUserId(payload)
  ) {
    return Response.json({
      type: 4,
      data: { content: "Toto tlačidlo patrí pridelenému človeku.", flags: 64 },
    });
  }

  if (answer === "yes") {
    const result = await admin.schema("invitation").from(
      "dishwasher_assignments",
    )
      .update({
        status: "confirmed",
        responded_at: new Date().toISOString(),
        source: "discord",
      })
      .eq("id", assignmentId);
    if (result.error) throw result.error;
    await syncDiscordShift(admin, assignmentResult.data.shift_id);
    return Response.json({
      type: 4,
      data: { content: "✅ Potvrdené, ďakujeme!", flags: 64 },
    });
  }

  const shiftResult = await admin.schema("invitation").from("dishwasher_shifts")
    .select("*").eq("id", assignmentResult.data.shift_id).single();
  if (shiftResult.error) throw shiftResult.error;
  const updateResult = await admin.schema("invitation").from(
    "dishwasher_assignments",
  )
    .update({
      status: "declined",
      responded_at: new Date().toISOString(),
      source: "discord",
    })
    .eq("id", assignmentId);
  if (updateResult.error) throw updateResult.error;
  await admin.schema("invitation").from("dishwasher_availability").upsert({
    member_id: assignmentResult.data.member_id,
    service_date: shiftResult.data.service_date,
    available: false,
    note: "Odmietnuté cez Discord",
  }, { onConflict: "member_id,service_date" });
  const bounds = monthBounds(shiftResult.data.service_date.slice(0, 7))!;
  await fillOpenPositions(admin, bounds);
  await syncDiscordShift(admin, assignmentResult.data.shift_id);
  return Response.json({
    type: 4,
    data: {
      content: "Rozumiem. Systém našiel náhradu, ak bol niekto dostupný.",
      flags: 64,
    },
  });
}

async function loadMemberPortalState(admin: any, memberId: string) {
  const memberResult = await admin.schema("invitation").from(
    "dishwasher_members",
  ).select("id,name,active").eq("id", memberId).single();
  if (memberResult.error || !memberResult.data?.active) {
    throw new Error("Osobný odkaz už nie je aktívny");
  }

  const today = bratislavaNowParts().date;
  const endDate = addCalendarDays(today, 190);
  const shiftsResult = await admin.schema("invitation").from(
    "dishwasher_shifts",
  ).select("id,service_date").gte("service_date", today).lte(
    "service_date",
    endDate,
  ).order("service_date");
  if (shiftsResult.error) throw shiftsResult.error;
  const shifts = (shiftsResult.data ?? []) as Shift[];

  let assignments: Assignment[] = [];
  if (shifts.length) {
    const assignmentsResult = await admin.schema("invitation").from(
      "dishwasher_assignments",
    ).select("id,shift_id,member_id,position,status,source").in(
      "shift_id",
      shifts.map((shift) => shift.id),
    ).eq("position", SHIFT_POSITIONS[0]).in("status", ACTIVE_STATUSES).order(
      "position",
    );
    if (assignmentsResult.error) throw assignmentsResult.error;
    assignments = assignmentsResult.data ?? [];
  }

  const memberIds = [...new Set(assignments.map((item) => item.member_id))];
  const names = new Map<string, string>();
  if (memberIds.length) {
    const membersResult = await admin.schema("invitation").from(
      "dishwasher_members",
    ).select("id,name").in("id", memberIds);
    if (membersResult.error) throw membersResult.error;
    for (const member of membersResult.data ?? []) {
      names.set(member.id, member.name);
    }
  }

  const schedule = shifts.map((shift) => {
    const people = SHIFT_POSITIONS.map((position) => {
      const assignment = assignments.find((item) =>
        item.shift_id === shift.id && item.position === position
      );
      if (!assignment) return null;
      const isMine = assignment.member_id === memberId;
      return {
        name: names.get(assignment.member_id) ?? "Neznámy človek",
        status: assignment.status,
        isMine,
        assignmentId: isMine ? assignment.id : null,
      };
    });
    return {
      id: shift.id,
      serviceDate: shift.service_date,
      people,
      confirmedCount: people.filter((person) =>
        person?.status === "confirmed"
      ).length,
    };
  });

  return {
    member: { name: memberResult.data.name },
    today,
    schedule,
  };
}

async function handleMemberPortal(req: Request, admin: any) {
  const basics = validateRequestBasics(req);
  if (!basics.ok) return basics.response;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }

  let memberId: string | null = null;
  try {
    memberId = await memberIdFromPortalToken(parsed.data.token);
  } catch (error) {
    console.error("Dishwasher member token failed", error);
  }
  if (!memberId) {
    return json(
      req,
      { success: false, error: "Osobný odkaz je neplatný" },
      403,
    );
  }

  const action = cleanText(parsed.data.action, 40);
  try {
    if (action === "get_portal_state") {
      return json(req, {
        success: true,
        ...(await loadMemberPortalState(admin, memberId)),
      });
    }

    if (action === "respond_assignment") {
      const assignmentId = cleanText(parsed.data.assignmentId, 36);
      const answer = cleanText(parsed.data.answer, 20);
      if (!assignmentId || !["confirm", "decline"].includes(answer ?? "")) {
        return json(req, { success: false, error: "Neplatná odpoveď" }, 400);
      }
      const assignmentResult = await admin.schema("invitation").from(
        "dishwasher_assignments",
      ).select("*").eq("id", assignmentId).eq("member_id", memberId).in(
        "status",
        ACTIVE_STATUSES,
      ).maybeSingle();
      if (assignmentResult.error) throw assignmentResult.error;
      if (!assignmentResult.data) {
        return json(req, {
          success: false,
          error: "Táto služba už nie je aktuálna",
        }, 409);
      }
      const assignment = assignmentResult.data as Assignment;
      const shiftResult = await admin.schema("invitation").from(
        "dishwasher_shifts",
      ).select("*").eq("id", assignment.shift_id).single();
      if (shiftResult.error) throw shiftResult.error;
      const shift = shiftResult.data as Shift;
      if (shift.service_date < bratislavaNowParts().date) {
        return json(req, {
          success: false,
          error: "Minulú službu už nie je možné upraviť",
        }, 409);
      }

      if (answer === "confirm") {
        const update = await admin.schema("invitation").from(
          "dishwasher_assignments",
        ).update({
          status: "confirmed",
          responded_at: new Date().toISOString(),
          source: "portal",
        }).eq("id", assignment.id);
        if (update.error) throw update.error;
        try {
          await syncDiscordShift(admin, shift.id);
        } catch (error) {
          console.error("Dishwasher confirmation Discord sync failed", error);
        }
        return json(req, {
          success: true,
          message: "Služba je potvrdená",
          ...(await loadMemberPortalState(admin, memberId)),
        });
      }

      const decline = await admin.schema("invitation").from(
        "dishwasher_assignments",
      ).update({
        status: "declined",
        responded_at: new Date().toISOString(),
        source: "portal",
      }).eq("id", assignment.id);
      if (decline.error) throw decline.error;
      const availability = await admin.schema("invitation").from(
        "dishwasher_availability",
      ).upsert({
        member_id: memberId,
        service_date: shift.service_date,
        available: false,
        note: "Odmietnuté cez osobný rozpis",
      }, { onConflict: "member_id,service_date" });
      if (availability.error) throw availability.error;

      const bounds = monthBounds(shift.service_date.slice(0, 7))!;
      await fillOpenPositions(admin, bounds, shift.service_date);
      const replacementResult = await admin.schema("invitation").from(
        "dishwasher_assignments",
      ).select("member_id").eq("shift_id", shift.id).eq(
        "position",
        assignment.position,
      ).in("status", ACTIVE_STATUSES).maybeSingle();
      if (replacementResult.error) throw replacementResult.error;
      let replacementName: string | null = null;
      if (replacementResult.data?.member_id) {
        const replacementMember = await admin.schema("invitation").from(
          "dishwasher_members",
        ).select("name").eq("id", replacementResult.data.member_id).single();
        if (replacementMember.error) throw replacementMember.error;
        replacementName = replacementMember.data.name;
      }

      let discordUpdated = true;
      try {
        await replaceDiscordMessagesForShift(admin, shift.id);
      } catch (error) {
        discordUpdated = false;
        console.error("Dishwasher replacement Discord sync failed", error);
      }
      return json(req, {
        success: true,
        replacementName,
        discordUpdated,
        message: replacementName
          ? `Náhradu preberá ${replacementName}`
          : "Služba je označená ako voľná",
        ...(await loadMemberPortalState(admin, memberId)),
      });
    }

    return json(req, { success: false, error: "Neznáma akcia" }, 400);
  } catch (error) {
    console.error("Dishwasher member portal failed", action, error);
    const message = error instanceof Error ? error.message : "Operácia zlyhala";
    return json(req, { success: false, error: message }, 500);
  }
}

Deno.serve(async (req) => {
  const admin = createAdminClient(readServiceKey());
  if (!admin) {
    return json(
      req,
      { success: false, error: "Server nie je nakonfigurovaný" },
      500,
    );
  }

  if (new URL(req.url).pathname.endsWith("/discord")) {
    try {
      return await handleDiscord(req, admin);
    } catch (error) {
      console.error("Discord dishwasher interaction failed", error);
      return Response.json({
        type: 4,
        data: {
          content: "Akciu sa nepodarilo uložiť. Skús to znova.",
          flags: 64,
        },
      });
    }
  }
  if (new URL(req.url).pathname.endsWith("/member")) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    return await handleMemberPortal(req, admin);
  }
  if (new URL(req.url).pathname.endsWith("/cron")) {
    try {
      return await handleRosterCron(req, admin);
    } catch (error) {
      console.error("Dishwasher roster cron failed", error);
      return json(
        req,
        { success: false, error: "Automatické upozornenie zlyhalo" },
        500,
      );
    }
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  const basics = validateRequestBasics(req);
  if (!basics.ok) return basics.response;
  if (!requireStaff(req)) {
    return json(
      req,
      { success: false, error: "Nesprávny prístupový kľúč" },
      403,
    );
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return json(req, { success: false, error: parsed.error }, 400);
  }
  const action = cleanText(parsed.data.action, 40);
  const bounds = monthBounds(parsed.data.month);
  if (!bounds) {
    return json(req, { success: false, error: "Neplatný mesiac" }, 400);
  }

  try {
    if (action === "get_state") {
      return json(req, { success: true, ...(await loadState(admin, bounds)) });
    }

    if (action === "generate_month") {
      await ensureShifts(admin, bounds);
      const result = await fillOpenPositions(admin, bounds);
      return json(req, {
        success: true,
        ...result,
        ...(await loadState(admin, bounds)),
      });
    }

    if (action === "save_member") {
      const id = cleanText(parsed.data.id, 36);
      const name = cleanText(parsed.data.name, 120);
      const email = cleanText(parsed.data.email, 254)?.toLowerCase() ?? null;
      const discordUserIdValue = cleanText(parsed.data.discordUserId, 22);
      if (
        !name || !validEmail(email) || !validDiscordUserId(discordUserIdValue)
      ) {
        return json(req, {
          success: false,
          error: "Skontroluj meno, email a Discord ID",
        }, 400);
      }
      const values = {
        name,
        email,
        discord_user_id: discordUserIdValue,
        active: parsed.data.active !== false,
      };
      const query = id
        ? admin.schema("invitation").from("dishwasher_members").update(values)
          .eq("id", id)
        : admin.schema("invitation").from("dishwasher_members").insert(values);
      const result = await query.select("*").single();
      if (result.error) throw result.error;
      if (id && values.active === false) {
        const shiftsResult = await admin.schema("invitation").from(
          "dishwasher_shifts",
        ).select("id").gte(
          "service_date",
          new Date().toISOString().slice(0, 10),
        );
        if (shiftsResult.error) throw shiftsResult.error;
        const futureShiftIds = (shiftsResult.data ?? []).map((
          shift: { id: string },
        ) => shift.id);
        if (futureShiftIds.length) {
          const releaseResult = await admin.schema("invitation").from(
            "dishwasher_assignments",
          ).update({ status: "replaced" }).eq("member_id", id)
            .in("shift_id", futureShiftIds).in("status", ACTIVE_STATUSES);
          if (releaseResult.error) throw releaseResult.error;
          await fillOpenPositions(admin, bounds);
        }
      }
      return json(req, {
        success: true,
        member: result.data,
        ...(await loadState(admin, bounds)),
      });
    }

    if (action === "import_members") {
      const entries = Array.isArray(parsed.data.members)
        ? parsed.data.members.slice(0, 250)
        : [];
      if (!entries.length) {
        return json(
          req,
          { success: false, error: "Súbor neobsahuje žiadnych ľudí" },
          400,
        );
      }

      let created = 0;
      let updated = 0;
      const seenEmails = new Set<string>();
      for (const rawEntry of entries) {
        if (!rawEntry || typeof rawEntry !== "object") continue;
        const entry = rawEntry as Record<string, unknown>;
        const name = cleanText(entry.name, 120);
        const email = cleanText(entry.email, 254)?.toLowerCase() ?? null;
        const discordUserIdValue = cleanText(entry.discordUserId, 22);
        if (
          !name || !email || !validEmail(email) ||
          !validDiscordUserId(discordUserIdValue) || seenEmails.has(email)
        ) {
          continue;
        }
        seenEmails.add(email);

        const existing = await admin.schema("invitation").from(
          "dishwasher_members",
        ).select("id").eq("email", email).maybeSingle();
        if (existing.error) throw existing.error;
        const values = {
          name,
          email,
          discord_user_id: discordUserIdValue,
          active: true,
        };
        const writeResult = existing.data
          ? await admin.schema("invitation").from("dishwasher_members")
            .update(values).eq("id", existing.data.id)
          : await admin.schema("invitation").from("dishwasher_members")
            .insert(values);
        if (writeResult.error) throw writeResult.error;
        if (existing.data) updated += 1;
        else created += 1;
      }

      if (!created && !updated) {
        return json(
          req,
          {
            success: false,
            error: "Nenašiel sa platný riadok s menom a emailom",
          },
          400,
        );
      }
      return json(req, {
        success: true,
        created,
        updated,
        skipped: entries.length - created - updated,
        ...(await loadState(admin, bounds)),
      });
    }

    if (action === "set_availability") {
      const memberId = cleanText(parsed.data.memberId, 36);
      const serviceDate = cleanText(parsed.data.serviceDate, 10);
      if (
        !memberId || !serviceDate || !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)
      ) {
        return json(req, { success: false, error: "Neplatná dostupnosť" }, 400);
      }
      const available = parsed.data.available !== false;
      const availabilityResult = await admin.schema("invitation").from(
        "dishwasher_availability",
      ).upsert({
        member_id: memberId,
        service_date: serviceDate,
        available,
        note: cleanText(parsed.data.note, 300),
      }, { onConflict: "member_id,service_date" });
      if (availabilityResult.error) throw availabilityResult.error;
      const shift =
        (await admin.schema("invitation").from("dishwasher_shifts").select("*")
          .eq("service_date", serviceDate).maybeSingle()).data;
      if (!available && shift) {
        const current = await admin.schema("invitation").from(
          "dishwasher_assignments",
        )
          .update({
            status: "declined",
            responded_at: new Date().toISOString(),
          })
          .eq("shift_id", shift.id).eq("member_id", memberId).in(
            "status",
            ACTIVE_STATUSES,
          );
        if (current.error) throw current.error;
        await fillOpenPositions(admin, bounds);
        await syncDiscordShift(admin, shift.id);
      }
      return json(req, { success: true, ...(await loadState(admin, bounds)) });
    }

    if (action === "assign_member") {
      const shiftId = cleanText(parsed.data.shiftId, 36);
      const memberId = cleanText(parsed.data.memberId, 36);
      const position = Number(parsed.data.position);
      if (!shiftId || !memberId || position !== SHIFT_POSITIONS[0]) {
        return json(req, { success: false, error: "Neplatné pridelenie" }, 400);
      }
      const oldResult = await admin.schema("invitation").from(
        "dishwasher_assignments",
      )
        .update({ status: "replaced" }).eq("shift_id", shiftId).eq(
          "position",
          position,
        ).in("status", ACTIVE_STATUSES);
      if (oldResult.error) throw oldResult.error;
      const insertResult = await admin.schema("invitation").from(
        "dishwasher_assignments",
      )
        .insert({
          shift_id: shiftId,
          member_id: memberId,
          position,
          status: "pending",
          source: "manual",
        });
      if (insertResult.error) throw insertResult.error;
      await syncDiscordShift(admin, shiftId);
      return json(req, { success: true, ...(await loadState(admin, bounds)) });
    }

    if (action === "publish_month") {
      const webhook = discordWebhookConfig();
      const botChannelId = cleanText(parsed.data.channelId, 22) ??
        Deno.env.get("DISCORD_DISHWASHER_CHANNEL_ID")?.trim() ?? "";
      const botConfigured = Boolean(
        Deno.env.get("DISCORD_DISHWASHER_BOT_TOKEN")?.trim() &&
          /^\d{15,22}$/.test(botChannelId),
      );
      if (!webhook && !botConfigured) {
        return json(
          req,
          { success: false, error: "Discord nie je nakonfigurovaný" },
          400,
        );
      }
      const state = await loadState(admin, bounds);
      const members = state.members as Member[];
      const assignments = state.assignments as Assignment[];
      let published = 0;
      for (const shift of state.shifts as Shift[]) {
        const channelId = webhook?.threadId ?? botChannelId;
        const payload = await discordShiftPayload(
          shift,
          assignments,
          members,
          !webhook,
        );
        let messageId = shift.discord_message_id;
        if (webhook && messageId && shift.discord_channel_id === channelId) {
          await discordWebhookRequest(webhook, `/messages/${messageId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          });
        } else if (webhook) {
          const message = await discordWebhookRequest(webhook, "", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          messageId = message.id;
        } else if (messageId && shift.discord_channel_id === channelId) {
          await discordRequest(`/channels/${channelId}/messages/${messageId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          });
        } else {
          const message = await discordRequest(
            `/channels/${channelId}/messages`,
            { method: "POST", body: JSON.stringify(payload) },
          );
          messageId = message.id;
        }
        const updateResult = await admin.schema("invitation").from(
          "dishwasher_shifts",
        ).update({
          discord_channel_id: channelId,
          discord_message_id: messageId,
          published_at: new Date().toISOString(),
        }).eq("id", shift.id);
        if (updateResult.error) throw updateResult.error;
        published += 1;
      }
      return json(req, {
        success: true,
        published,
        ...(await loadState(admin, bounds)),
      });
    }

    return json(req, { success: false, error: "Neznáma akcia" }, 400);
  } catch (error) {
    console.error("Dishwasher roster action failed", action, error);
    const message = error instanceof Error ? error.message : "Operácia zlyhala";
    return json(req, { success: false, error: message }, 500);
  }
});
