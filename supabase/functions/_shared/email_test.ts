import { sendEmail } from "./email.ts";

function assertEquals<T>(actual: T, expected: T) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("sends the Resend idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = Deno.env.get("RESEND_API_KEY");
  const originalFrom = Deno.env.get("EMAIL_FROM");
  let requestHeaders = new Headers();

  Deno.env.set("RESEND_API_KEY", "re_test");
  Deno.env.set("EMAIL_FROM", "New Level <hello@example.com>");
  globalThis.fetch = (_input, init) => {
    const headers = (init as { headers?: HeadersInit } | undefined)?.headers;
    requestHeaders = new Headers(headers);
    return Promise.resolve(Response.json({ id: "email-1" }));
  };

  try {
    const result = await sendEmail(
      "person@example.com",
      "Pozvánka",
      "Text pozvánky",
      undefined,
      { idempotencyKey: "message-queue/queue-1" },
    );

    assertEquals(result, { ok: true, providerMessageId: "email-1" });
    assertEquals(
      requestHeaders.get("Idempotency-Key"),
      "message-queue/queue-1",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", originalApiKey);
    if (originalFrom === undefined) Deno.env.delete("EMAIL_FROM");
    else Deno.env.set("EMAIL_FROM", originalFrom);
  }
});
