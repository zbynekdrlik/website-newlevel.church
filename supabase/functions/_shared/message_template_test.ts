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
