#!/bin/bash
# SFM Cloudflare Infrastructure - One-Click Setup
# This script sets up the entire Cloudflare stack (D1, Worker, 2x Pages).
# Prerequisites:
#   - npx wrangler (installed via `npm install -g wrangler` or `bun install`)
#   - Logged in: `npx wrangler login`
#   - HELIUS_API_KEY set in environment

set -e

echo "=== SFM Indexer - Full Deployment ==="

# Check prerequisites
if [ -z "$HELIUS_API_KEY" ]; then
    echo "ERROR: HELIUS_API_KEY env var is not set."
    echo "Run: export HELIUS_API_KEY='your-key'"
    exit 1
fi

# 1. Create D1 database if not exists
echo "=== Step 1: D1 Database ==="
DB_NAME="sfm-indexer-db"
DB_EXISTS=$(npx wrangler d1 list --json 2>/dev/null | grep -c "\"$DB_NAME\"" || true)
if [ "$DB_EXISTS" -eq "0" ]; then
    echo "Creating new D1 database '$DB_NAME'..."
    npx wrangler d1 create "$DB_NAME"
    echo "IMPORTANT: Copy the database_id above into wrangler.toml"
    read -p "Press Enter once wrangler.toml is updated..."
else
    echo "Database '$DB_NAME' already exists."
fi

# 2. Apply schema
echo "=== Step 2: Apply Schema ==="
npx wrangler d1 execute "$DB_NAME" --file=schema.sql --remote --yes

# 3. Set secrets
echo "=== Step 3: Set Secrets ==="
echo "$HELIUS_API_KEY" | npx wrangler secret put HELIUS_API_KEY
echo "Enter a random string for REFRESH_SECRET:"
read REFRESH_SECRET
echo "$REFRESH_SECRET" | npx wrangler secret put REFRESH_SECRET

# 4. Deploy Worker
echo "=== Step 4: Deploy Worker ==="
npx wrangler deploy

# 5. Deploy Dashboard
echo "=== Step 5: Deploy Dashboard ==="
npx wrangler pages deploy dashboard --project-name=sfm-dashboard --branch=master

# 6. Deploy Claim Page
echo "=== Step 6: Deploy Claim Page ==="
npx wrangler pages deploy landing --project-name=sfm-claim --branch=master

echo ""
echo "=== DEPLOYMENT COMPLETE ==="
echo "Check your URLs:"
echo "  Dashboard: https://sfm-dashboard.pages.dev"
echo "  Claim Page: https://master.sfm-claim.pages.dev"
echo "  API: https://sfm-cf-indexer.<your-subdomain>.workers.dev"
