import { formatEventDate } from "./message_template.ts";
import { partyEventLocalTimestamp } from "./party_event_time.ts";

function assertEquals(actual: string, expected: string) {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, received ${actual}`);
  }
}

Deno.test("stores the October 30 Youth event at 18:00 Bratislava time", () => {
  const startsAt = partyEventLocalTimestamp("2026-10-30", "18:00");
  assertEquals(startsAt, "2026-10-30T18:00:00+01:00");
  assertEquals(
    formatEventDate({ event_date: "2026-10-30", starts_at: startsAt }),
    "v piatok 30. októbra o 18:00",
  );
});

Deno.test("keeps the summer offset and handles the clock-change day", () => {
  assertEquals(
    partyEventLocalTimestamp("2026-10-16", "18:00"),
    "2026-10-16T18:00:00+02:00",
  );
  assertEquals(
    partyEventLocalTimestamp("2026-10-25", "00:00"),
    "2026-10-25T00:00:00+02:00",
  );
  assertEquals(
    partyEventLocalTimestamp("2026-10-25", "18:00"),
    "2026-10-25T18:00:00+01:00",
  );
  assertEquals(
    partyEventLocalTimestamp("2027-03-28", "00:00"),
    "2027-03-28T00:00:00+01:00",
  );
  assertEquals(
    partyEventLocalTimestamp("2027-03-28", "18:00"),
    "2027-03-28T18:00:00+02:00",
  );
});
