import { buildRegistrationUrl } from "./registration_url.ts";

export function renderContactTemplate(
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
