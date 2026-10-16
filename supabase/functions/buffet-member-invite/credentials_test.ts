import { createInvitationCredentials } from "./credentials.ts";

Deno.test("invitation credentials meet Supabase Auth password constraints", () => {
  const passwords = new Set<string>();
  const emails = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const { email, password } = createInvitationCredentials();
    const bytes = new TextEncoder().encode(password).byteLength;
    if (bytes < 32 || bytes > 72) {
      throw new Error(
        `Auth password must be at most 72 bytes; received ${bytes}`,
      );
    }
    for (const pattern of [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]) {
      if (!pattern.test(password)) {
        throw new Error("Missing password character class");
      }
    }
    if (!email.endsWith("@members.bufet.newlevel.church")) {
      throw new Error("Unexpected invitation identity domain");
    }
    if (passwords.has(password) || emails.has(email)) {
      throw new Error("Invitation credentials must be unique per account");
    }
    passwords.add(password);
    emails.add(email);
  }
});
