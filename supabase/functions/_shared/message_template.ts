import { buildRegistrationUrl } from "./registration_url.ts";

function bratislavaDayNumber(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Europe/Bratislava",
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
  ) /
    86_400_000;
}

export function formatEventDate(
  event: Record<string, unknown> | null,
  sentAt: Date | string = new Date(),
) {
  const eventDate = typeof event?.event_date === "string"
    ? event.event_date
    : "";
  const startsAt = typeof event?.starts_at === "string" ? event.starts_at : "";
  const rawDate = eventDate || startsAt;
  if (!rawDate) return "";

  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? new Date(`${rawDate}T12:00:00+02:00`)
    : new Date(rawDate);
  if (Number.isNaN(parsedDate.getTime())) return rawDate;

  const formattedDate = new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Bratislava",
  }).format(parsedDate);
  const parsedSentAt = sentAt instanceof Date ? sentAt : new Date(sentAt);
  const isTomorrow = !Number.isNaN(parsedSentAt.getTime()) &&
    bratislavaDayNumber(parsedDate) - bratislavaDayNumber(parsedSentAt) === 1;

  return isTomorrow ? `zajtra ${formattedDate}` : formattedDate;
}

export function renderContactTemplate(
  template: string,
  contact: Record<string, unknown>,
  event: Record<string, unknown> | null,
  sentAt: Date | string = new Date(),
) {
  const name = typeof contact.name === "string" ? contact.name : "";
  const values: Record<string, string> = {
    name,
    first_name: name.trim().split(/\s+/)[0] || "Ahoj",
    email: typeof contact.email === "string" ? contact.email : "",
    phone: typeof contact.phone === "string" ? contact.phone : "",
    event_name: String(event?.title ?? "New Level Party"),
    event_date: formatEventDate(event, sentAt),
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
