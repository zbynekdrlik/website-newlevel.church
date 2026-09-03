import { buildRegistrationUrl } from "./registration_url.ts";

export function formatEventDate(event: Record<string, unknown> | null) {
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

  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Bratislava",
  }).format(parsedDate);
}

export function renderContactTemplate(
  template: string,
  contact: Record<string, unknown>,
  event: Record<string, unknown> | null,
) {
  const name = typeof contact.name === "string" ? contact.name : "";
  const values: Record<string, string> = {
    name,
    first_name: name.trim().split(/\s+/)[0] || "Ahoj",
    email: typeof contact.email === "string" ? contact.email : "",
    phone: typeof contact.phone === "string" ? contact.phone : "",
    event_name: String(event?.title ?? "New Level Party"),
    event_date: formatEventDate(event),
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
