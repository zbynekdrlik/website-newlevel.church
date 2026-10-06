# WhatsApp delivery receipts

The message queue's sent status means Meta accepted the send request. It does
not mean WhatsApp delivered the message to the recipient. Meta reports later
sent, delivered, read, and failed status events to the whatsapp-webhook Edge
Function. The admin history displays the latest status and any Meta error code
or description.

## Enable the webhook

1. Apply the database migration and deploy the callback:
   supabase db push --linked
   supabase functions deploy admin-sms --no-verify-jwt
   supabase functions deploy whatsapp-webhook --no-verify-jwt
   ./deploy.sh
2. In Supabase secrets, set:
   - WHATSAPP_APP_SECRET: the App Secret from Meta for the app connected to this
     WhatsApp Business Account.
   - WHATSAPP_WEBHOOK_VERIFY_TOKEN: a long random value used only for webhook
     verification.
3. In Meta for Developers, open the connected app's Webhooks product, configure
   the WhatsApp Business Account callback URL as
   https://kbpuhcuiljbwgxgiauku.supabase.co/functions/v1/whatsapp-webhook, enter
   the same verification token, and subscribe to the messages field.

The endpoint verifies Meta's X-Hub-Signature-256 HMAC on every POST. The
verification token and app secret must stay in Supabase secrets; neither belongs
in the static site.

Delivery receipts only exist in this database for events received after the
webhook is enabled. Meta message IDs from older sends do not let this app
retrieve a missing receipt retroactively.
