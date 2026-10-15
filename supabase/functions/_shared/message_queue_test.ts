import {
  dedupeMessageRecipients,
  dispatchDueMessages,
  whatsappBodyParameters,
} from "./message_queue.ts";

function assertEquals<T>(actual: T, expected: T) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("claims due messages atomically before dispatching", async () => {
  const calls: unknown[] = [];
  const admin = {
    schema(schema: string) {
      calls.push({ schema });
      return {
        rpc(functionName: string, parameters: Record<string, unknown>) {
          calls.push({ functionName, parameters });
          return Promise.resolve({ data: [], error: null });
        },
      };
    },
  };

  const result = await dispatchDueMessages(admin, 100, {
    automationId: "manual-send-1",
  });

  assertEquals(calls, [
    { schema: "invitation" },
    {
      functionName: "claim_due_messages",
      parameters: {
        p_limit: 50,
        p_automation_id: "manual-send-1",
      },
    },
  ]);
  assertEquals(result, { ok: true, processed: 0, results: [] });
});

Deno.test("deduplicates recipients within each channel", () => {
  const rows = dedupeMessageRecipients([
    { id: "first", channel: "whatsapp", recipient: "+421900000001" },
    { id: "duplicate", channel: "whatsapp", recipient: "+421900000001" },
    { id: "sms", channel: "sms", recipient: "+421900000001" },
    { id: "email", channel: "email", recipient: " Person@Example.com " },
    {
      id: "email-duplicate",
      channel: "email",
      recipient: "person@example.com",
    },
  ]);

  assertEquals(rows.map((row) => row.id), ["first", "sms", "email"]);
});

Deno.test("does not duplicate the fixed time in a WhatsApp template", () => {
  const parameters = {
    bodyParameters: ["Alex", "v piatok 16. októbra o 18:00"],
    eventDate: "2026-10-16",
    whatsappTemplateIncludesTime: true,
  };
  assertEquals(
    whatsappBodyParameters(
      parameters,
      "youth_invitation_sk",
      "2026-10-15T17:00:00Z",
    ),
    ["Alex", "zajtra"],
  );
  assertEquals(
    whatsappBodyParameters({
      ...parameters,
      whatsappTemplateIncludesTime: false,
    }, "youth_out"),
    ["Alex", "v piatok 16. októbra o 18:00"],
  );
  assertEquals(
    whatsappBodyParameters(
      { bodyParameters: parameters.bodyParameters },
      "youth_invitation_sk",
    ),
    ["Alex", "v piatok 16. októbra"],
  );
});
