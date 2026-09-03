# New Level Church website

## Product and stack

- Static Astro 5 site deployed to Cloudflare Pages as `newlevel-church`.
- Supabase project `kbpuhcuiljbwgxgiauku` provides the `invitation` schema and Deno Edge Functions.
- The messaging admin is `src/pages/admin/sms.astro`; its API is `supabase/functions/admin-sms/index.ts`.

## Messaging architecture

- Outbound SMS, WhatsApp, and email rows are stored in `invitation.message_queue`.
- Shared provider dispatch lives in `supabase/functions/_shared/message_queue.ts` and is imported by the admin, cron, and authenticated queue dispatcher functions.
- Campaign WhatsApp messages must use an approved Meta template. The default is `youth_invitation_sk` with language `sk`; body parameter 1 is the contact's first name and parameter 2 is the localized event date.
- WhatsApp free text is only appropriate inside the 24-hour customer-service window.
- Provider credentials and the service-role key belong only in Supabase secrets, never browser code.
- Party registrations are handled by `register-party`; it sends Discord notifications directly with the `DISCORD_PARTY_WEBHOOK_URL` Supabase secret. Do not reintroduce n8n into this path.
- The public Party food counter reads `GET register-party` so `invitation.party_registrations` remains the source of truth; Cloudflare KV is only a legacy availability fallback.
- Before enabling or repairing the cron, inspect overdue queued rows: all due rows can be delivered immediately once the cron becomes healthy.

## Commands

```bash
npm run dev
npm run build
deno fmt --check supabase/functions
deno check supabase/functions/admin-sms/index.ts
supabase db push --linked
./deploy.sh
```

Deploy only changed Edge Functions. Functions that validate their own admin or cron header are deployed with `--no-verify-jwt`.
