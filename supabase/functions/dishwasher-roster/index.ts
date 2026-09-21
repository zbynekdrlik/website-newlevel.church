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
  source: "automatic" | "manual" | "discord";
};

const ACTIVE_STATUSES = ["pending", "confirmed"];

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

  return {
    members: membersResult.data ?? [],
    shifts,
    availability: availabilityResult.data ?? [],
    assignments,
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
) {
  const state = await loadState(admin, bounds);
  const members = (state.members as Member[]).filter((member) => member.active);
  if (!members.length) return { added: 0, unfilled: state.shifts.length * 2 };

  const unavailable = new Set(
    state.availability.filter((row: any) => row.available === false)
      .map((row: any) => `${row.member_id}:${row.service_date}`),
  );
  const activeAssignments = [...state.assignments] as Assignment[];
  const history = await assignmentHistory(admin, members, bounds.end);
  let added = 0;
  let unfilled = 0;

  for (const shift of state.shifts as Shift[]) {
    for (const position of [1, 2]) {
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

function discordShiftPayload(
  shift: Shift,
  assignments: Assignment[],
  members: Member[],
) {
  const byId = new Map(members.map((member) => [member.id, member]));
  const active = assignments.filter((assignment) =>
    assignment.shift_id === shift.id &&
    ACTIVE_STATUSES.includes(assignment.status)
  );
  const fields = [1, 2].map((position) => {
    const assignment = active.find((item) => item.position === position);
    const member = assignment ? byId.get(assignment.member_id) : null;
    const status = assignment?.status === "confirmed"
      ? "✅ potvrdené"
      : assignment
      ? "⏳ čaká na potvrdenie"
      : "⚠️ voľné miesto";
    return {
      name: `Miesto ${position}`,
      value: member ? `**${member.name}**\n${status}` : status,
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
      footer: { text: "Pridelený človek potvrdí svoju možnosť nižšie." },
    }],
    components: buttons.length
      ? [{ type: 1, components: buttons.slice(0, 5) }]
      : [],
  };
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
  await discordRequest(
    `/channels/${shift.discord_channel_id}/messages/${shift.discord_message_id}`,
    {
      method: "PATCH",
      body: JSON.stringify(
        discordShiftPayload(shift, assignmentsResult.data, membersResult.data),
      ),
    },
  );
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
      if (!shiftId || !memberId || ![1, 2].includes(position)) {
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
      const channelId = cleanText(parsed.data.channelId, 22) ??
        Deno.env.get("DISCORD_DISHWASHER_CHANNEL_ID")?.trim() ?? "";
      if (!/^\d{15,22}$/.test(channelId)) {
        return json(
          req,
          { success: false, error: "Chýba Discord channel ID" },
          400,
        );
      }
      const state = await loadState(admin, bounds);
      const members = state.members as Member[];
      const assignments = state.assignments as Assignment[];
      let published = 0;
      for (const shift of state.shifts as Shift[]) {
        const payload = discordShiftPayload(shift, assignments, members);
        let messageId = shift.discord_message_id;
        if (messageId && shift.discord_channel_id === channelId) {
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
