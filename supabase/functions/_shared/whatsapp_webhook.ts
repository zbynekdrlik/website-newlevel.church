export function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyWhatsAppSignature(
  rawBody: string,
  signature: string | null,
  appSecret: string,
) {
  if (!appSecret || !signature?.startsWith("sha256=")) return false;
  const supplied = signature.slice("sha256=".length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;

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
  const expected = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(supplied, expected);
}
