export function actionLink(
  raw: string | undefined,
  type: "invite" | "recovery",
  origin: string,
  supabaseUrl: string,
) {
  try {
    const link = new URL(raw ?? "");
    const authOrigin = new URL(supabaseUrl).origin;
    const redirect = new URL(link.searchParams.get("redirect_to") ?? "");
    if (
      link.origin !== authOrigin || link.pathname !== "/auth/v1/verify" ||
      link.searchParams.get("type") !== type ||
      redirect.origin !== origin || redirect.pathname !== "/" ||
      redirect.search || redirect.hash
    ) return null;
    return link.toString();
  } catch {
    return null;
  }
}
