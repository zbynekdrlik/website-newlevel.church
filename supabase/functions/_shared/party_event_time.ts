const BRATISLAVA = "Europe/Bratislava";

/** Store a local event time with the offset that applies on that date. */
export function partyEventLocalTimestamp(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Invalid event date or time");
  }

  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    utcGuess.getUTCFullYear() !== year ||
    utcGuess.getUTCMonth() !== month - 1 ||
    utcGuess.getUTCDate() !== day || hour > 23 || minute > 59
  ) {
    throw new Error("Invalid event date or time");
  }

  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: BRATISLAVA,
    timeZoneName: "shortOffset",
  }).formatToParts(utcGuess).find((part) => part.type === "timeZoneName")
    ?.value;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone ?? "");
  if (!match) throw new Error("Bratislava time zone offset unavailable");

  const offset = `${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
  return `${date}T${time}:00${offset}`;
}
