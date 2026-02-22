#!/bin/bash
# Deploy newlevel.church to Cloudflare Pages
# Usage: ./deploy.sh

set -e

PROJECT_NAME="newlevel-church"

echo "Deploying to Cloudflare Pages ($PROJECT_NAME)..."
npx wrangler pages deploy . --project-name "$PROJECT_NAME" --branch main

echo ""
echo "Deploy complete! Site will be live at https://newlevel.church shortly."
