import { actionLink } from "./auth_links.ts";

const authUrl = "https://example.supabase.co";
const origin = "https://bufet.newlevel.church";

Deno.test("accepts only a Supabase verification link for the requested action and Bufet origin", () => {
  const valid = `${authUrl}/auth/v1/verify?type=invite&token=abc&redirect_to=${
    encodeURIComponent(origin)
  }`;
  if (actionLink(valid, "invite", origin, authUrl) !== valid) {
    throw new Error("Expected valid invite link");
  }
  const normalized = valid.replace(
    encodeURIComponent(origin),
    encodeURIComponent(`${origin}/`),
  );
  if (actionLink(normalized, "invite", origin, authUrl) !== normalized) {
    throw new Error("Expected root URL with trailing slash");
  }
  for (
    const invalid of [
      valid.replace("type=invite", "type=recovery"),
      valid.replace(
        "redirect_to=",
        "redirect_to=https%3A%2F%2Fevil.example%2F&other=",
      ),
      valid.replace(authUrl, "https://evil.example"),
      valid.replace("/auth/v1/verify", "/other"),
    ]
  ) {
    if (actionLink(invalid, "invite", origin, authUrl) !== null) {
      throw new Error("Accepted an unsafe authentication link");
    }
  }
});
