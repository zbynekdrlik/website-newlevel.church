#!/usr/bin/env bash

set -euo pipefail

PROJECT_REF="kbpuhcuiljbwgxgiauku"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Chýba Supabase CLI. Nainštaluj ho a prihlás sa cez: supabase login"
  exit 1
fi

read -r -s -p "Discord webhook URL (nebude zobrazená): " WEBHOOK_URL
echo
read -r -p "ID vlákna PARTY registracia: " THREAD_ID

WEBHOOK_URL="${WEBHOOK_URL%/}"
THREAD_ID="${THREAD_ID//[[:space:]]/}"

if [[ ! "$WEBHOOK_URL" =~ ^https://(www\.)?discord\.com/api/webhooks/[0-9]+/.+ ]]; then
  echo "Neplatná Discord webhook URL. Musí začínať https://discord.com/api/webhooks/..."
  exit 1
fi

if [[ ! "$THREAD_ID" =~ ^[0-9]{17,20}$ ]]; then
  echo "Neplatné ID vlákna. V Discorde použi Copy Thread ID."
  exit 1
fi

if [[ "$WEBHOOK_URL" == *"thread_id="* ]]; then
  DISCORD_PARTY_WEBHOOK_URL="$WEBHOOK_URL"
elif [[ "$WEBHOOK_URL" == *"?"* ]]; then
  DISCORD_PARTY_WEBHOOK_URL="${WEBHOOK_URL}&thread_id=${THREAD_ID}"
else
  DISCORD_PARTY_WEBHOOK_URL="${WEBHOOK_URL}?thread_id=${THREAD_ID}"
fi

echo "Ukladám DISCORD_PARTY_WEBHOOK_URL do Supabase projektu ${PROJECT_REF}..."
supabase secrets set \
  "DISCORD_PARTY_WEBHOOK_URL=${DISCORD_PARTY_WEBHOOK_URL}" \
  --project-ref "$PROJECT_REF"

unset WEBHOOK_URL THREAD_ID DISCORD_PARTY_WEBHOOK_URL
echo "Hotovo. Tajná webhook URL bola uložená v Supabase."
