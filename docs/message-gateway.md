# Message Gateway

Toto je serverova brana pre tyzdenne New Level Party pozvanky.

## Princip

- Kazdy piatok je samostatny riadok v `invitation.party_events`.
- Prihlasenia sa ukladaju do `invitation.party_registrations`.
- Novy tyzden sa neresetuje mazanim. Vytvori sa novy event a registracie sa pocitaju iba pre tento event.
- Pozvanky sa najprv zapisu do `invitation.message_queue`.
- Odosielanie robi az `dispatch-message-queue`.
- WhatsApp kampane pouzivaju schvalenu Meta sablonu. `template_name`,
  `template_language` a `template_parameters` sa ukladaju priamo do queue riadku.

## Pravidlo vyberu

`queue-party-invitations` vyberie aktivne kontakty z `invitation.contacts`, ktore este nemaju registraciu na konkretny `party_event`.

Strategia:

- `sms_then_email` - ak ma telefon a `sms_enabled = true`, queue SMS; inak email.
- `email_only` - len email.
- `sms_only` - len SMS.

## SMS cez TextBee

TextBee endpoint pouziva iba serverova Supabase Edge Function:

- `POST https://api.textbee.dev/api/v1/gateway/send-sms`
- header `x-api-key`
- body `recipients`, `message`, `deviceId`

API key a device ID su iba v Supabase secrets.

## WhatsApp cez Meta Cloud API

Kampan alebo prva sprava mimo 24-hodinoveho okna musi pouzit schvalenu Meta
sablonu. Admin predvolene pouziva `youth_invitation_sk` (`sk`): prvy parameter
je krstne meno kontaktu a druhy parameter je datum vybranej mladeze. Volny text
je urceny iba na odpoved do 24 hodin od poslednej spravy pouzivatela.

Token a ID telefonneho cisla su iba v Supabase secrets:

```bash
supabase secrets set WHATSAPP_ACCESS_TOKEN="..."
supabase secrets set WHATSAPP_PHONE_NUMBER_ID="..."
```

## Manualny tok cez queue

V stvrtok o 16:00 vytvor queue pre najblizsi piatok:

```bash
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/queue-party-invitations" \
  -H "Authorization: Bearer ADMIN_USER_JWT" \
  -H "Content-Type: application/json" \
  --data '{
    "strategy": "sms_then_email",
    "body": "Ahoj {{name}}, pozyvame ta tento piatok na New Level Party. Das vediet, ci prides?"
  }'
```

Potom odosli queue:

```bash
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/dispatch-message-queue" \
  -H "Authorization: Bearer ADMIN_USER_JWT" \
  -H "Content-Type: application/json" \
  --data '{ "limit": 20 }'
```

## Secrets pre realne posielanie

Email cez Resend:

```bash
supabase secrets set RESEND_API_KEY="..."
supabase secrets set EMAIL_FROM="New Level Youth <party@newlevel.church>"
```

`EMAIL_FROM` musi byt domena alebo sender overeny v Resend.

TextBee SMS:

```bash
supabase secrets set TEXTBEE_API_KEY="..."
supabase secrets set TEXTBEE_DEVICE_ID="..."
```

Bez tychto secrets sa spravy oznacia ako failed s chybou provider not configured. To je zamerne, aby sa neposielalo nic neocakavane.

## Email test

Admin-only test jedneho emailu:

```bash
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/test-email" \
  -H "Authorization: Bearer ADMIN_USER_JWT" \
  -H "Content-Type: application/json" \
  --data '{
    "to": "test@example.com",
    "subject": "Prides tento piatok na New Level Youth?",
    "body": "Ahoj, tento piatok o 18:00 mame New Level Youth. Das nam prosim vediet, ci prides?"
  }'
```

## Cron dispatcher

Cron vola `dispatch-message-cron` a spracuje iba spravy, ktorym uz nastal `scheduled_for`.
Endpoint nie je verejny na anonymne posielanie; chrani ho `CRON_SECRET`.

## Priamy cron tok

Supabase Cron moze volat `dispatch-messages`. Funkcia sama vyberie aktivne kontakty, ktore maju `phone`, `sms_enabled = true`, este nie su prihlasene na dany event a este nemaju `sent` log pre rovnaky `automationId`.

```bash
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/dispatch-messages" \
  -H "Authorization: Bearer ADMIN_USER_JWT" \
  -H "Content-Type: application/json" \
  --data '{
    "automationId": "party-sms-reminder-2026-08-14",
    "eventDate": "2026-08-14",
    "message": "Ahoj {{name}}, tento piatok je New Level Party. Este nie si prihlaseny/a, das vediet, ci prides?",
    "limit": 30
  }'
```

## Test jednej SMS

Admin-only test:

```bash
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/test-textbee-sms" \
  -H "Authorization: Bearer ADMIN_USER_JWT" \
  -H "Content-Type: application/json" \
  --data '{
    "to": "+421900000000",
    "message": "Test SMS z New Level systemu"
  }'
```
