export function createInvitationCredentials() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // 256 random bits plus all required character classes, within Auth's 72-byte limit.
  const password =
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
      .join("") + "Aa1!";

  return {
    email: `${crypto.randomUUID()}@members.bufet.newlevel.church`,
    password,
  };
}
