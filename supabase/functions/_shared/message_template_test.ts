import {
  findUnsafeRelativeDatePhrase,
  renderContactTemplate,
} from "./message_template.ts";

function assertEquals<T>(actual: T, expected: T) {
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

  assertEquals(message, "Stretneme sa v piatok 4. septembra o 18:00.");
});

Deno.test("formats the date from starts_at when event_date is unavailable", () => {
  const message = renderContactTemplate(
    "Stretneme sa {{event_date}}.",
    {},
    { starts_at: "2026-09-04T18:30:00+02:00" },
    "2026-08-30T12:00:00+02:00",
  );

  assertEquals(message, "Stretneme sa v piatok 4. septembra o 18:30.");
});

Deno.test("keeps the absolute date when sent the day before the event", () => {
  const message = renderContactTemplate(
    "Stretneme sa {{event_date}}.",
    {},
    { event_date: "2026-09-04", title: "New Level Youth" },
    "2026-09-03T18:30:00+02:00",
  );

  assertEquals(message, "Stretneme sa v piatok 4. septembra o 18:00.");
});

Deno.test("detects relative date wording that can become stale", () => {
  assertEquals(findUnsafeRelativeDatePhrase("Príď zajtra o 18:00."), "zajtra");
  assertEquals(
    findUnsafeRelativeDatePhrase("Vidíme sa tento piatok."),
    "tento piatok",
  );
  assertEquals(findUnsafeRelativeDatePhrase("Vidíme sa v piatok."), "v piatok");
  assertEquals(
    findUnsafeRelativeDatePhrase("Vidíme sa {{event_date}}."),
    null,
  );
  assertEquals(
    findUnsafeRelativeDatePhrase("Stretávame sa každý piatok."),
    null,
  );
});
