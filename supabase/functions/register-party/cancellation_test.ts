import {
  createCancellationToken,
  readCancellationToken,
} from "./cancellation.ts";

Deno.test("cancellation links are signed and expire", async () => {
  const claim = {
    registrationId: "9af27995-ec85-4f14-85c7-8fc639a1ff1c",
    registeredAt: "2026-10-28T12:00:00+00:00",
    eventDate: "2026-10-30",
  };
  const now = Date.parse("2026-10-28T12:01:00Z");
  const token = await createCancellationToken(claim, "server-secret", now);
  const decoded = await readCancellationToken(token, "server-secret", now);
  if (JSON.stringify(decoded) !== JSON.stringify(claim)) {
    throw new Error("A valid link did not return its registration");
  }
  if (await readCancellationToken(token, "another-secret", now)) {
    throw new Error("A link was accepted with a different secret");
  }
  const changed = `${token.slice(0, 10)}A${token.slice(11)}`;
  if (await readCancellationToken(changed, "server-secret", now)) {
    throw new Error("A changed link was accepted");
  }
  if (
    await readCancellationToken(token, "server-secret", now + 60 * 60 * 1000)
  ) {
    throw new Error("An expired link was accepted");
  }
});
