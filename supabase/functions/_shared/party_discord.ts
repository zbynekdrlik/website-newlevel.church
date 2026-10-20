type Notification = {
  registration_id: string;
  generation: number;
  attempts: number;
};

type Registration = {
  event_id: string;
  contact_id: string;
  wants_food: boolean;
  message: string | null;
};

type Contact = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

function cleanDiscordText(value: unknown, fallback: string, maxLength = 500) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(
    /\s+/g,
    " ",
  ).trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function discordEventDate(value: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Bratislava",
  }).format(new Date(`${value}T12:00:00Z`));
}

function discordPayload(
  contact: Contact,
  registration: Registration,
  eventDate: string,
  count: number | null,
) {
  const message = cleanDiscordText(registration.message, "žiadna");
  return {
    username: "New Level registrácie",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "Nová registrácia na Party",
      color: 0x9acd32,
      fields: [
        {
          name: "Meno",
          value: cleanDiscordText(contact.name, "neuvedené", 120),
          inline: true,
        },
        {
          name: "Telefón",
          value: cleanDiscordText(contact.phone, "neuvedené", 32),
          inline: true,
        },
        {
          name: "Jedlo",
          value: registration.wants_food ? "ÁNO" : "NIE",
          inline: true,
        },
        {
          name: "Email",
          value: cleanDiscordText(contact.email, "neuvedené", 254),
          inline: true,
        },
        { name: "Termín", value: discordEventDate(eventDate), inline: true },
        {
          name: "Aktuálne prihlásených",
          value: count === null ? "nedostupné" : String(count),
          inline: true,
        },
        ...(message === "žiadna"
          ? []
          : [{ name: "Správa", value: message, inline: false }]),
      ],
      footer: { text: "Reaguj ✅ na potvrdenie registrácie." },
      timestamp: new Date().toISOString(),
    }],
  };
}

function retryDelaySeconds(attempts: number, retryAfter: string | null) {
  const requested = Number(retryAfter);
  const backoff = Math.min(3600, 10 * 2 ** Math.min(attempts - 1, 9));
  return Math.max(
    backoff,
    Number.isFinite(requested) && requested > 0 ? requested : 0,
  );
}

export async function dispatchPartyDiscordNotifications(
  admin: any,
  limit = 20,
  registrationId: string | null = null,
) {
  const { data, error } = await admin.schema("invitation")
    .rpc("claim_party_discord_notifications", {
      p_limit: limit,
      p_registration_id: registrationId,
    });
  if (error || !data) {
    console.error("Party Discord queue claim failed", error?.code ?? "no_data");
    return { ok: false as const, processed: 0, sent: 0 };
  }

  let sent = 0;
  for (const notification of data as Notification[]) {
    let failure = "unknown_error";
    let retryAfter: string | null = null;
    try {
      const { data: registration, error: registrationError } = await admin
        .schema("invitation").from("party_registrations")
        .select("event_id,contact_id,wants_food,message")
        .eq("id", notification.registration_id).single();
      if (registrationError || !registration) {
        throw new Error("registration_unavailable");
      }

      const [contactResult, eventResult] = await Promise.all([
        admin.schema("invitation").from("contacts")
          .select("name,email,phone").eq("id", registration.contact_id)
          .single(),
        admin.schema("invitation").from("party_events")
          .select("event_date").eq("id", registration.event_id).single(),
      ]);
      if (contactResult.error || !contactResult.data) {
        throw new Error("contact_unavailable");
      }
      if (eventResult.error || !eventResult.data) {
        throw new Error("event_unavailable");
      }

      const eventDate = eventResult.data.event_date as string;
      // Count again with the event date; the registration itself remains saved if this count fails.
      const count = await admin.rpc("get_party_registration_count", {
        p_event_date: eventDate,
      });
      const registrationCount = count.error || count.data == null ||
          !Number.isSafeInteger(Number(count.data))
        ? null
        : Number(count.data);
      const webhookUrl = Deno.env.get("DISCORD_PARTY_WEBHOOK_URL")?.trim();
      if (!webhookUrl) throw new Error("webhook_not_configured");

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload(
          contactResult.data as Contact,
          registration as Registration,
          eventDate,
          registrationCount,
        )),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        retryAfter = response.headers.get("Retry-After");
        throw new Error(`discord_http_${response.status}`);
      }

      const { error: updateError } = await admin.schema("invitation")
        .from("party_discord_notifications")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          claimed_at: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("registration_id", notification.registration_id)
        .eq("generation", notification.generation);
      if (updateError) throw new Error("status_update_failed");
      sent += 1;
      continue;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      failure =
        /^(registration_unavailable|contact_unavailable|event_unavailable|webhook_not_configured|discord_http_\d{3}|status_update_failed)$/
            .test(message)
          ? message
          : "network_error";
    }

    console.error("Party Discord notification failed", {
      registrationId: notification.registration_id,
      attempt: notification.attempts,
      reason: failure,
    });
    const retryAt = new Date(
      Date.now() + retryDelaySeconds(notification.attempts, retryAfter) * 1000,
    );
    const { error: updateError } = await admin.schema("invitation")
      .from("party_discord_notifications")
      .update({
        status: "queued",
        next_attempt_at: retryAt.toISOString(),
        claimed_at: null,
        last_error: failure,
        updated_at: new Date().toISOString(),
      })
      .eq("registration_id", notification.registration_id)
      .eq("generation", notification.generation);
    if (updateError) {
      console.error("Party Discord retry scheduling failed", updateError.code);
    }
  }

  return { ok: true as const, processed: data.length, sent };
}
