import {
  emailImageAttachmentFromBytes,
  renderPartyEmailHtml,
  sendEmail,
} from "./email.ts";

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
    const attachment = emailImageAttachmentFromBytes(
      Uint8Array.of(0xff, 0xd8, 0xff),
      "photo.jpg",
      "campaign-image",
    );
    if (!attachment) throw new Error("Expected a valid JPEG attachment");
    const result = await sendEmail(
      "person@example.com",
      "Pozvánka",
      "Text pozvánky",
      renderPartyEmailHtml("Pozvánka", "Text pozvánky", {
        imageContentId: attachment.contentId,
      }),
      {
        idempotencyKey: "message-queue/queue-1",
        attachments: [attachment],
      },
    );

    assertEquals(result, { ok: true, providerMessageId: "email-1" });
    assertEquals(
      requestHeaders.get("Idempotency-Key"),
      "message-queue/queue-1",
    );
    assertEquals(requestBody.attachments, [{
      filename: "photo.jpg",
      content_type: "image/jpeg",
      content_id: "campaign-image",
      content: "/9j/",
    }]);
    if (!(requestBody.html as string).includes('src="cid:campaign-image"')) {
      throw new Error("Expected the email HTML to reference the inline photo");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", originalApiKey);
    if (originalFrom === undefined) Deno.env.delete("EMAIL_FROM");
    else Deno.env.set("EMAIL_FROM", originalFrom);
  }
});
