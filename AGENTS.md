# New Level Church website

## Product and stack

- Static Astro 5 site deployed to Cloudflare Pages as `newlevel-church`.
  Pushing `main` runs `.github/workflows/deploy.yml` with the project's
  Cloudflare account secrets. Direct `./deploy.sh` requires credentials for
  that same account.
- Supabase project `kbpuhcuiljbwgxgiauku` provides the `invitation` schema and
  Deno Edge Functions.
- The separate Buffet app keeps its database migration in this project's
  `supabase/migrations/20261015120000_buffet_initial.sql` and catalog extension
  `supabase/migrations/20261015130000_buffet_catalog.sql`. One-time member links
  are in `supabase/migrations/20261016133000_buffet_member_invitations.sql` and
  `supabase/functions/buffet-member-invite/index.ts`. Its `buffet` schema
  is private; authenticated clients use `public.buffet_*` invoker wrappers.
  Do not expose `buffet` through the Data API or grant direct table access. The
  invitation Edge Function is the only component that creates seller Auth
  users; raw invite tokens and generated passwords must never be persisted.
  Its authenticated PWA handoff action generates a one-time magic-link hash for
  the same active invitation account after checking JWT and membership. Deploy
  this function before the Bufet frontend; do not expose service credentials or
  copy refresh tokens into the PWA.
  Auth passwords must fit the 72-byte limit; run
  `deno test supabase/functions/buffet-member-invite/credentials_test.ts` when
  changing invitation credentials. Production invitation checks must exercise
  successful redemption and session access, not only invalid-token responses.
  Member permissions live in `20261016150000_buffet_member_permissions.sql`:
  sales/reversals, meetings/cash, restocking, and products/categories/photos are
  independent boolean grants. Only active admins set these grants; admin access
  is implicit. RPCs and photo Storage RLS must enforce current grants and active
  membership. Existing/new sellers retain sales/meetings access by default.
  Optional inventory tracking is in `20261019160000_buffet_optional_stock.sql`:
  `products.track_stock` defaults true and `sales.stock_tracked` snapshots whether
  inventory was consumed. Reversal must use the sale's snapshot even after a
  product mode change. The nine-argument product-details RPC requires an explicit
  tracking boolean; the legacy eight-argument RPC preserves existing modes.
  `20261019173000_buffet_cancel_meeting.sql` adds open-meeting cancellation for
  active admins only. It uses the meeting lock, restores unreversed sales'
  consumed stock from `stock_tracked`, preserves restocks/audit rows, and records
  `cancelled_at`/`cancelled_by` with terminal `closed_at`. Retries are no-ops;
  closed meetings remain immutable. All reports must exclude cancelled meetings.
  Regression tests live in the Bufet sibling's `tests/test_database.sh`.
  Hosted Storage allows updating policy conditions, but renaming a policy on
  `storage.objects` fails with an owner error for the CLI migration role; retain
  the existing policy names when changing their conditions.
- The messaging admin is `src/pages/admin/sms.astro`; its API is
  `supabase/functions/admin-sms/index.ts`.
- The Youth page `src/pages/youth/index.astro` loads
  `src/content/party/photos/*.json` for its gallery and rotating hero. Every
  photo path must exist under `public/`; activity photos are selected by
  `activityPhotosByTitle` in the page.
- Homepage hero photos in `src/content/homepage/hero.json` fill the viewport;
  use large originals, not the 600×400 gallery thumbnails in `public/images/uploads/`.

## Messaging architecture

- Outbound SMS, WhatsApp, and email rows are stored in
  `invitation.message_queue`.
- Email campaign photos are normalized to JPEG and stored privately in the
  `email-campaign-images` Storage bucket. Email queue rows reference the image
  at `template_parameters.emailImagePath`; the shared dispatcher embeds a
  seven-day signed Storage URL in the HTML so mail clients load the photo without
  a MIME attachment. Treat that URL as shareable access to the single image for
  its expiry period; keep the bucket private. WhatsApp image headers continue
  to use one-hour signed URLs. The optional `Potvrdiť účasť` button is controlled
  by the admin and stored in `template_parameters.emailCtaEnabled`; legacy rows
  keep the button enabled.
- Shared provider dispatch lives in
  `supabase/functions/_shared/message_queue.ts` and is imported by the admin,
  cron, and authenticated queue dispatcher functions.
- Dispatchers must claim due rows through `invitation.claim_due_messages`;
  never send rows selected directly from `queued`, because manual and cron
  dispatch can overlap. Queued Resend emails use the queue ID as their provider
  idempotency key.
- Multiple contacts may normalize to the same phone number. Manual queue rows
  are deduplicated by channel and recipient, and the database trigger populates
  `recipient_dedupe_key` so one automation cannot send repeatedly to the same
  destination through different contact IDs.
- Campaign WhatsApp messages must use an approved Meta template. The default is
  `youth_invitation` with language `sk`; body parameter 1 is the contact's
  first name. Both `youth_invitation` and `youth_invitation_sk` add `o 18:00`
  after body parameter 2, so the dispatcher must send only the day (`zajtra`
  when sent the day before the event, otherwise the localized date), even when
  a saved or queued `whatsappTemplateIncludesTime` flag is false. Templates
  without a fixed time, such as `youth_out`, require the full date and time in
  parameter 2, even if a saved flag is true. The dispatcher formats relative
  wording at actual send time. If Meta reports that a template expects exactly
  one body parameter, dispatch retries with the first name only.
- Campaign photos are stored in the private `email-campaign-images` bucket. If
  a WhatsApp template reports that its header expects an image, dispatch signs
  that stored photo URL and retries with an image header component.
- `{{event_date}}` inserts the selected event's localized weekday, date without
  a year, and time (for example `v piatok 18. septembra o 18:00`). Static
  wording such as `zajtra` or `tento piatok` is allowed in message text and is
  not automatically warned about or rejected; use the variable when the date
  should follow the selected event.
- Supabase returns `starts_at` timestamps normalized to UTC. Always format their
  time with the `Europe/Bratislava` time zone; never extract the raw ISO hour.
- The currently used `youth_out` Meta template has the timing line `📅 {{2}}`
  with no static time. Parameter 2 must contain the complete localized event
  timing from `formatEventDate`, such as `v piatok 2. októbra o 18:00`.
- The `📅` glyph has a platform-specific date baked into its artwork (often
  `17 JUL` or `24 FEB`); it does not reflect the event date. Changing it requires
  a new or edited approved Meta template, preferably using `🕕` instead.
- WhatsApp free text is only appropriate inside the 24-hour customer-service
  window.
- Provider credentials and the service-role key belong only in Supabase secrets,
  never browser code.
- Party registrations are handled by `register-party`; it sends Discord
  notifications with the `DISCORD_PARTY_WEBHOOK_URL` Supabase secret. The
  registration trigger queues each alert in `invitation.party_discord_notifications`;
  `register-party` sends immediately and `dispatch-message-cron` retries failures.
  Do not reintroduce n8n into this path.
- The public Party food counter reads `GET register-party` so
  `invitation.party_registrations` remains the source of truth; Cloudflare KV is
  only a legacy availability fallback.
- Discord registration notifications show the total registrations for that
  event date, including people who did not request food. Count registration
  rows, not the food counter.
- Before enabling or repairing the cron, inspect overdue queued rows: all due
  rows can be delivered immediately once the cron becomes healthy.

## WhatsApp delivery receipts

- The WhatsApp queue status sent means Meta accepted the API request; it does
  not confirm recipient delivery. The whatsapp-webhook Edge Function verifies
  Meta's signature and stores the latest sent, delivered, read, or failed
  receipt on the queue row. Set WHATSAPP_APP_SECRET and
  WHATSAPP_WEBHOOK_VERIFY_TOKEN in Supabase and subscribe the Meta WABA to the
  messages webhook field. Setup steps are in docs/whatsapp-delivery-webhook.md.

## Staff dishwasher roster

- The private roster UI is `src/pages/staff/riad.astro`; all roster data and
  mutations go through `supabase/functions/dishwasher-roster/index.ts` using the
  `DISHWASHER_STAFF_KEY` secret. The static page must never receive the
  service-role key.
- Roster tables use the `invitation.dishwasher_*` prefix. Only `pending` and
  `confirmed` assignments occupy a shift position; declined/replaced rows are
  retained as history.
- Automatic assignment fills Thursday and Sunday with one active, available
  person, prioritizing the lowest one-year assignment count and then the oldest
  last assignment.
- Members can be added individually or imported from a CSV with `meno`/`name`,
  `email`, and optional `discord_id` columns. Imports update an existing member
  when the normalized email matches.
- `dishwasher_members.also_buffet` is a member-level flag. Discord schedules
  and reminders label assigned people with that flag as `riady + bufet`.
- Discord confirmations use an application bot and signed component
  interactions, not webhook reactions. They require
  `DISCORD_DISHWASHER_BOT_TOKEN`, `DISCORD_DISHWASHER_PUBLIC_KEY`, and
  `DISCORD_DISHWASHER_CHANNEL_ID`. A member's Discord user ID must match the
  account clicking their confirmation button.
- One-way notifications can instead target only a Discord thread using
  `DISCORD_DISHWASHER_WEBHOOK_URL` plus `DISCORD_DISHWASHER_THREAD_ID`; webhook
  mode intentionally omits confirmation buttons.
- Members confirm or decline through signed personal links at `/riad`; links use
  `DISHWASHER_MEMBER_LINK_SECRET`, and the public endpoint returns
  names/statuses only. Declining fills the vacated position and replaces the
  latest relevant Discord webhook messages.
- The database calls `/dishwasher-roster/cron` hourly; at 09:00
  Europe/Bratislava it posts the full schedule on day 1 and a reminder for the
  assigned person one day before each shift.
  `invitation.dishwasher_notification_runs` prevents duplicate posts.
- Deployment and Discord application setup are documented in
  `docs/dishwasher-roster.md`.

## Commands

```bash
npm run dev
npm run build
deno fmt --check supabase/functions
deno check supabase/functions/admin-sms/index.ts
supabase db push --linked
./deploy.sh
```

Deploy only changed Edge Functions. Functions that validate their own admin or
cron header are deployed with `--no-verify-jwt`.
