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
