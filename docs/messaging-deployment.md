# Messaging deployment

This project uses the existing Supabase `invitation.message_queue` architecture.

## Required Variables

Set these as Supabase secrets:

```bash
supabase secrets set SUPABASE_URL="https://kbpuhcuiljbwgxgiauku.supabase.co"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="..."
supabase secrets set SUPABASE_PUBLISHABLE_KEY="..."
supabase secrets set ADMIN_EMAILS="admin@example.com"
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
```

Cloudflare Pages only needs public/static site config. Do not put `RESEND_API_KEY`,
`INFOBIP_API_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` into browser code.

## Deploy Functions

```bash
supabase functions deploy admin-sms --project-ref kbpuhcuiljbwgxgiauku --use-api
supabase functions deploy dispatch-message-cron --project-ref kbpuhcuiljbwgxgiauku --use-api --no-verify-jwt
supabase functions deploy dispatch-message-queue --project-ref kbpuhcuiljbwgxgiauku --use-api
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
Supabase URL: https://kbpuhcuiljbwgxgiauku.supabase.co
Supabase anon/publishable key: from Supabase Dashboard > Project Settings > API
```

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
