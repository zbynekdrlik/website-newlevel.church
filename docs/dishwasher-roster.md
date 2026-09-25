# Dishwasher roster setup

The roster page is `/staff/riad`. It is a static shell; all private data is
loaded from the `dishwasher-roster` Edge Function after the shared staff key is
validated.

## Supabase

Apply and deploy only the roster changes:

```bash
supabase db push --linked
supabase functions deploy dishwasher-roster --no-verify-jwt
```

Set a long random staff key:

```bash
supabase secrets set DISHWASHER_STAFF_KEY='<random secret>'
```

## Discord application

For one-way notifications to a specific Discord thread, create a webhook in
the thread's parent text channel and set both values below. The thread ID keeps
all roster messages out of the parent channel:

```bash
supabase secrets set \
  DISCORD_DISHWASHER_WEBHOOK_URL='<webhook URL>' \
  DISCORD_DISHWASHER_THREAD_ID='<thread channel ID>'
```

The webhook URL is a credential. Store it only as a Supabase secret and rotate
it immediately if it is pasted into chat, an issue, or a repository.

The database cron calls `/dishwasher-roster/cron` hourly. At 09:00 in
`Europe/Bratislava` the function sends a complete schedule on the first day of
the month and, on other days, a reminder when a shift exists the following
day. Reminder messages mention only the two assigned members when their
`discord_user_id` values are present. Delivery claims are stored in
`invitation.dishwasher_notification_runs` so retries cannot duplicate a
monthly schedule or shift reminder.

The application bot setup below is only needed for interactive confirmation
and decline buttons.

Create a Discord application and bot in the Discord Developer Portal. Invite
the bot to the server with `View Channels`, `Send Messages`, `Embed Links`, and
`Read Message History` permissions. Enable Developer Mode in Discord and copy
the target channel ID plus every roster member's user ID.

Set the bot values as Supabase secrets:

```bash
supabase secrets set \
  DISCORD_DISHWASHER_BOT_TOKEN='<bot token>' \
  DISCORD_DISHWASHER_PUBLIC_KEY='<application public key>' \
  DISCORD_DISHWASHER_CHANNEL_ID='<channel id>'
```

In the application's General Information, set the Interactions Endpoint URL to:

```text
https://kbpuhcuiljbwgxgiauku.supabase.co/functions/v1/dishwasher-roster/discord
```

Discord checks the endpoint signature before accepting it. Keep the bot token,
public key, and staff key out of browser code and Git.

## Importing people

The People dialog accepts UTF-8 CSV files with comma or semicolon separators.
Required headers are `meno` (or `name`) and `email`; `discord_id` is optional.
Rows with an email already in the roster update that person instead of creating
a duplicate.
