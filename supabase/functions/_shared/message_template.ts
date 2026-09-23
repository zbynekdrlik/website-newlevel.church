import { buildRegistrationUrl } from "./registration_url.ts";

const RELATIVE_DATE_PATTERN =
  /\b(?:dnes|zajtra|pozajtra|(?:tento|túto|budúci|budúcu|najbližší|najbližšiu|v|vo)\s+(?:pondelok|utorok|stredu|streda|štvrtok|piatok|sobotu|sobota|nedeľu|nedeľa|týždeň))\b/iu;

export function findUnsafeRelativeDatePhrase(value: string) {
  return value.match(RELATIVE_DATE_PATTERN)?.[0] ?? null;
}

function eventDateParts(event: Record<string, unknown> | null) {
  const eventDate = typeof event?.event_date === "string"
    ? event.event_date
    : "";
  const startsAt = typeof event?.starts_at === "string" ? event.starts_at : "";
  const rawDate = eventDate || startsAt;
  if (!rawDate) return null;

  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? new Date(`${rawDate}T12:00:00+02:00`)
    : new Date(rawDate);
  if (Number.isNaN(parsedDate.getTime())) return null;

  const weekday = new Intl.DateTimeFormat("sk-SK", {
    weekday: "long",
    timeZone: "Europe/Bratislava",
  }).format(parsedDate);
  const formattedDate = new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Bratislava",
  }).format(parsedDate);
  const localTime = startsAt.match(/T(\d{2}):(\d{2})/)?.slice(1).join(":") ||
    "18:00";

  return { weekday, formattedDate, localTime };
}

export function formatEventDate(
  event: Record<string, unknown> | null,
  _sentAt: Date | string = new Date(),
) {
  const parts = eventDateParts(event);
  if (!parts) {
    return typeof event?.event_date === "string"
      ? event.event_date
      : typeof event?.starts_at === "string"
      ? event.starts_at
      : "";
  }
  return `v ${parts.weekday} ${parts.formattedDate} o ${parts.localTime}`;
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
