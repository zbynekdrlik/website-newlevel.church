import { renderPartyEmailHtml, sendEmail } from "./email.ts";

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
  let requestBody: Record<string, unknown> = {};

  Deno.env.set("RESEND_API_KEY", "re_test");
  Deno.env.set("EMAIL_FROM", "New Level <hello@example.com>");
  globalThis.fetch = (_input, init) => {
    const headers = (init as { headers?: HeadersInit } | undefined)?.headers;
    requestHeaders = new Headers(headers);
    requestBody = JSON.parse(String((init as RequestInit).body));
    return Promise.resolve(Response.json({ id: "email-1" }));
  };

  try {
    const imageUrl =
      "https://example.supabase.co/storage/v1/object/sign/campaign.jpg?token=test";
    const result = await sendEmail(
      "person@example.com",
      "Pozvánka",
      "Text pozvánky",
      renderPartyEmailHtml("Pozvánka", "Text pozvánky", {
        imageUrl,
      }),
      { idempotencyKey: "message-queue/queue-1" },
    );

    assertEquals(result, { ok: true, providerMessageId: "email-1" });
    assertEquals(
      requestHeaders.get("Idempotency-Key"),
      "message-queue/queue-1",
    );
    assertEquals(requestBody.attachments, undefined);
    if (!(requestBody.html as string).includes(`src="${imageUrl}"`)) {
      throw new Error("Expected the email HTML to reference the hosted photo");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", originalApiKey);
    if (originalFrom === undefined) Deno.env.delete("EMAIL_FROM");
    else Deno.env.set("EMAIL_FROM", originalFrom);
  }
});
