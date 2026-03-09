#!/bin/bash
# Deploy newlevel.church to Cloudflare Pages
# Usage: ./deploy.sh
#
# Prerequisites:
#   1. Run: npx wrangler login (authenticate with Cloudflare)
#   2. Run: npm install (if not done already)

set -e

PROJECT_NAME="newlevel-church"

echo "Building site..."
npm run build

echo ""
echo "Deploying to Cloudflare Pages ($PROJECT_NAME)..."
npx wrangler pages deploy dist --project-name "$PROJECT_NAME" --branch main

echo ""
echo "Deploy complete! Site will be live at https://newlevel.church shortly."
