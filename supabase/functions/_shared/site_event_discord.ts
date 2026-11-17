import { cleanDiscordText, retryDelaySeconds } from "./party_discord.ts";

type Notification = {
  registration_id: string;
  generation: number;
  attempts: number;
};

type Registration = {
  event_id: string;
  name: string;
  email: string;
  phone: string;
  wants_food: boolean;
};

type SiteEvent = {
  title: string;
  starts_at: string;
};

function discordPayload(
  registration: Registration,
  event: SiteEvent,
  generation: number,
) {
  const startsAt = new Intl.DateTimeFormat("sk-SK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Bratislava",
  }).format(new Date(event.starts_at));

  return {
    username: "New Level registrácie",
    allowed_mentions: { parse: [] },
    embeds: [{
      title:
        (generation > 1 ? "Aktualizovaná prihláška: " : "Nová registrácia: ") +
        cleanDiscordText(event.title, "Akcia", 150),
      color: 0x3ebbc0,
      fields: [
        {
          name: "Meno",
          value: cleanDiscordText(registration.name, "neuvedené", 120),
          inline: true,
        },
        {
          name: "Telefón",
          value: cleanDiscordText(registration.phone, "neuvedené", 32),
          inline: true,
        },
        {
          name: "Email",
          value: cleanDiscordText(registration.email, "neuvedené", 254),
          inline: false,
        },
        {
          name: "Jedlo",
          value: registration.wants_food ? "ÁNO" : "NIE",
          inline: true,
        },
        { name: "Termín", value: startsAt, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  };
}

export async function dispatchSiteEventDiscordNotifications(
  admin: any,
  limit = 20,
  registrationId: string | null = null,
) {
  const { data, error } = await admin.schema("invitation")
    .rpc("claim_site_event_discord_notifications", {
      p_limit: limit,
      p_registration_id: registrationId,
    });
  if (error || !data) {
    console.error(
      "Site event Discord queue claim failed",
      error?.code ?? "no_data",
    );
    return { ok: false as const, processed: 0, sent: 0 };
  }

  let sent = 0;
  for (const notification of data as Notification[]) {
    let failure = "unknown_error";
    let retryAfter: string | null = null;
    try {
      const { data: registration, error: registrationError } = await admin
        .schema("invitation").from("site_event_registrations")
        .select("event_id,name,email,phone,wants_food")
        .eq("id", notification.registration_id).single();
      if (registrationError || !registration) {
        throw new Error("registration_unavailable");
      }

      const { data: event, error: eventError } = await admin
        .schema("invitation").from("site_events")
        .select("title,starts_at")
        .eq("id", registration.event_id).single();
      if (eventError || !event) {
        throw new Error("event_unavailable");
      }

      const webhookUrl = Deno.env.get("DISCORD_PARTY_WEBHOOK_URL")?.trim();
      if (!webhookUrl) throw new Error("webhook_not_configured");

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload(
          registration as Registration,
          event as SiteEvent,
          notification.generation,
        )),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        retryAfter = response.headers.get("Retry-After");
        throw new Error("discord_http_" + response.status);
      }

      const { error: updateError } = await admin.schema("invitation")
        .from("site_event_discord_notifications")
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
        /^(registration_unavailable|event_unavailable|webhook_not_configured|discord_http_\d{3}|status_update_failed)$/
            .test(message)
          ? message
          : "network_error";
    }

    console.error("Site event Discord notification failed", {
      registrationId: notification.registration_id,
      attempt: notification.attempts,
      reason: failure,
    });
    const retryAt = new Date(
      Date.now() + retryDelaySeconds(notification.attempts, retryAfter) * 1000,
    );
    const { error: updateError } = await admin.schema("invitation")
      .from("site_event_discord_notifications")
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
      console.error(
        "Site event Discord retry scheduling failed",
        updateError.code,
      );
    }
  }

  return { ok: true as const, processed: data.length, sent };
}
