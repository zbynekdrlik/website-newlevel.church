import { renderContactTemplate } from "./message_template.ts";

function assertEquals(actual: string, expected: string) {
  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("personalizes first name in an email subject", () => {
  const subject = renderContactTemplate(
    "Ahoj {{first_name}}, tu Kristián z New Level Youth",
    { name: "Alex Orinin", email: "alex@example.com", phone: "+421900000000" },
    { event_date: "2026-08-21", title: "New Level Youth" },
  );

  assertEquals(subject, "Ahoj Alex, tu Kristián z New Level Youth");
});

Deno.test("supports whitespace inside subject placeholders", () => {
  const subject = renderContactTemplate(
    "Pozvánka pre {{ first_name }}",
    { name: "Mária Nováková" },
    null,
  );

  assertEquals(subject, "Pozvánka pre Mária");
});

Deno.test("formats an event date naturally in Slovak", () => {
  const message = renderContactTemplate(
    "Stretneme sa {{event_date}}.",
    {},
    { event_date: "2026-09-04", title: "New Level Youth" },
    "2026-08-30T12:00:00+02:00",
  );

  assertEquals(message, "Stretneme sa 4. septembra 2026.");
});

Deno.test("formats the date from starts_at when event_date is unavailable", () => {
  const message = renderContactTemplate(
    "Stretneme sa {{event_date}}.",
    {},
    { starts_at: "2026-09-04T18:30:00+02:00" },
    "2026-08-30T12:00:00+02:00",
  );

  assertEquals(message, "Stretneme sa 4. septembra 2026.");
});

Deno.test("adds zajtra when the message is sent the day before the event", () => {
  const message = renderContactTemplate(
    "Stretneme sa {{event_date}}.",
    {},
    { event_date: "2026-09-04", title: "New Level Youth" },
    "2026-09-03T18:30:00+02:00",
  );

  assertEquals(message, "Stretneme sa zajtra 4. septembra 2026.");
});
