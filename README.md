# Solfunmeme Data Indexer (Cloudflare Edge)

A 100% free, serverless data pipeline that indexes the Solfunmeme token on Solana and serves it via Cloudflare Workers & D1.

## Architecture
- **Backend:** Cloudflare Workers (Serverless)
- **Database:** Cloudflare D1 (SQLite Edge)
- **Frontend:** Cloudflare Pages (TailwindCSS)
- **Data Source:** Solana Mainnet via Helius RPC

## How it works
1. **Fast Sweep (Every 5 minutes):** Fetches the Top 20 holders using `getTokenLargestAccounts`.
2. **Full Sweep (Every 24h):** Fetches all ~3,700+ holders using `getTokenAccounts` and saves them to D1.
3. **Historical Snapshots:** Every run saves the balances into a `snapshots` table, allowing us to prove how long a wallet has continuously held the token.

## API Endpoints
- `GET /api/health` - System status and total holders tracked.
- `GET /api/holders?limit=N` - Returns the Top N holders.
- `GET /api/export` - Downloads the full list of holders as a CSV file.
- `GET /api/wallet/:address` - Gets the current balance of a specific wallet.
- `GET /api/prove?address=XXX&min=YYY` - Proves holding duration and calculates a Holder Score.
- `POST /api/refresh` - Forces a Top 20 refresh (Requires `Bearer` token).

## Holder Score Formula
The `/api/prove` endpoint calculates a loyalty score for the credit system:
`Score = (Current Tokens Held) * (Continuous Days Held)`

## Security
The `/api/refresh` endpoint requires an `Authorization: Bearer <REFRESH_SECRET>` header to prevent abuse of Helius API credits.
