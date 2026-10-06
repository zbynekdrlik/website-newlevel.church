import { verifyWhatsAppSignature } from "./whatsapp_webhook.ts";

Deno.test("verifies Meta's HMAC webhook signature", async () => {
  const rawBody = '{"object":"whatsapp_business_account"}';
  const appSecret = "test-meta-app-secret";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  const signature = "sha256=" +
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  if (!await verifyWhatsAppSignature(rawBody, signature, appSecret)) {
    throw new Error("Expected a valid Meta signature to pass");
  }
  if (await verifyWhatsAppSignature(rawBody + " ", signature, appSecret)) {
    throw new Error("Expected a changed request body to fail verification");
  }
  if (await verifyWhatsAppSignature(rawBody, null, appSecret)) {
    throw new Error("Expected a missing signature to fail verification");
  }
});
