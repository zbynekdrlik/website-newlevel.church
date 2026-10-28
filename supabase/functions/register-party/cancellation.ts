const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

type CancellationClaim = {
  registrationId: string;
  registeredAt: string;
  eventDate: string;
  expiresAt: number;
};

function encode(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decode(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    (character) => character.charCodeAt(0),
  );
}

async function signingKey(secret: string) {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`party-cancellation-v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createCancellationToken(
  claim: Omit<CancellationClaim, "expiresAt">,
  secret: string,
  now = Date.now(),
) {
  const payload = encode(new TextEncoder().encode(JSON.stringify({
    ...claim,
    expiresAt: now + TOKEN_LIFETIME_MS,
  })));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function readCancellationToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<Omit<CancellationClaim, "expiresAt"> | null> {
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return null;
  }
  try {
    const [payload, signature] = token.split(".");
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      decode(signature),
      new TextEncoder().encode(payload),
    );
    if (!valid) return null;
    const claim = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        claim.registrationId,
      ) ||
      typeof claim.registeredAt !== "string" ||
      !Number.isFinite(Date.parse(claim.registeredAt)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(claim.eventDate) ||
      !Number.isSafeInteger(claim.expiresAt) ||
      claim.expiresAt <= now ||
      claim.expiresAt > now + TOKEN_LIFETIME_MS
    ) return null;
    return {
      registrationId: claim.registrationId,
      registeredAt: claim.registeredAt,
      eventDate: claim.eventDate,
    };
  } catch {
    return null;
  }
}
