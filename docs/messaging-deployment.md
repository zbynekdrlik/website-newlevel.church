# Messaging deployment

This project uses the existing Supabase `invitation.message_queue` architecture.

## Required Variables

Set these as Supabase secrets:

```bash
supabase secrets set SUPABASE_URL="https://kbpuhcuiljbwgxgiauku.supabase.co"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="..."
supabase secrets set SUPABASE_PUBLISHABLE_KEY="..."
supabase secrets set ADMIN_EMAILS="admin@example.com"
supabase secrets set ADMIN_SMS_KEY="long-random-admin-sms-key"
supabase secrets set ALLOWED_ORIGINS="https://newlevel.church,http://localhost:4321"
supabase secrets set DEFAULT_PHONE_COUNTRY_CODE="+421"
supabase secrets set CRON_SECRET="long-random-secret"
supabase secrets set RESEND_API_KEY="re_..."
supabase secrets set EMAIL_FROM="New Level Youth <youth@newlevel.church>"
supabase secrets set INFOBIP_API_KEY="..."
supabase secrets set INFOBIP_BASE_URL="https://xxxxx.api.infobip.com"
supabase secrets set INFOBIP_SMS_SENDER="NewLevel"
supabase secrets set SMS_TEST_MODE="true"
supabase secrets set SMS_TEST_ALLOWED_NUMBERS="+421..."
supabase secrets set WHATSAPP_ACCESS_TOKEN="..."
supabase secrets set WHATSAPP_PHONE_NUMBER_ID="..."
```

Discord notifications for new Party registrations use an incoming webhook that
targets the `PARTY registracia` thread. Configure it without writing the secret
to the repository or shell history:

```bash
./configure-discord-webhook.sh
```

The script asks for the base Discord webhook URL and the thread ID separately,
then stores the combined `DISCORD_PARTY_WEBHOOK_URL` in the linked Supabase
project.

`CRON_SECRET` must also be stored in Supabase Vault under the exact name
`dispatch_message_cron_secret`. Both values must be identical: the database
cron reads the Vault value into the `x-cron-secret` header and the
`dispatch-message-cron` Edge Function compares it with `CRON_SECRET`.

Create one random value, set it as the Edge Function secret, and store the same
value in Vault through the Supabase SQL editor:

```bash
CRON_SECRET_VALUE="$(openssl rand -hex 32)"
supabase secrets set CRON_SECRET="$CRON_SECRET_VALUE" \
  --project-ref kbpuhcuiljbwgxgiauku
```

```sql
select vault.create_secret(
  'same-value-as-CRON_SECRET',
  'dispatch_message_cron_secret',
  'Shared secret for the dispatch-message-cron Edge Function'
);
```

Before enabling or repairing the cron in an existing environment, inspect
`invitation.message_queue` for overdue `queued` rows. Once authentication is
fixed, all due rows are eligible for immediate delivery.

Cloudflare Pages only needs public/static site config. Do not put `RESEND_API_KEY`,
`INFOBIP_API_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` into browser code.

## Deploy Functions

```bash
supabase functions deploy admin-sms --project-ref kbpuhcuiljbwgxgiauku --use-api --no-verify-jwt
supabase functions deploy dispatch-message-cron --project-ref kbpuhcuiljbwgxgiauku --use-api --no-verify-jwt
supabase functions deploy dispatch-message-queue --project-ref kbpuhcuiljbwgxgiauku --use-api --no-verify-jwt
supabase functions deploy dispatch-messages --project-ref kbpuhcuiljbwgxgiauku --use-api
supabase functions deploy queue-party-invitations --project-ref kbpuhcuiljbwgxgiauku --use-api
supabase functions deploy test-email --project-ref kbpuhcuiljbwgxgiauku --use-api
```

Only deploy SMS-related changed functions unless you intentionally want to update
the other downloaded function sources.

## Admin UI

The SMS admin page is:

```text
/admin/sms
```

On production:

```text
https://newlevel.church/admin/sms
```

Use:

```text
Admin API key: value from ADMIN_SMS_KEY
```

The admin page stores the key only in this browser's local storage. The key is
sent to the `admin-sms` Edge Function as `x-admin-sms-key`; the Infobip API key
and Supabase service role key stay only in Supabase secrets.

For campaign WhatsApp messages, use an approved Meta template. The admin defaults
to `youth_invitation_sk` in language `sk`; template body parameter 1 is the
recipient's first name and parameter 2 is the selected event date in Slovak.
Free-text WhatsApp messages are only for replies inside Meta's 24-hour
customer-service window.

## Test Mode

Keep this enabled while Infobip is on limited/free SMS:

```bash
supabase secrets set SMS_TEST_MODE="true"
supabase secrets set SMS_TEST_ALLOWED_NUMBERS="+421..."
```

When a test SMS is received and campaign filtering is verified:

```bash
supabase secrets set SMS_TEST_MODE="false"
```
