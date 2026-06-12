# Deploying the dashboard cron Worker

This Worker refreshes the build dashboard every 6 hours with no laptop involved.
It reads the app list from KV (`dashboard-config`, written by the laptop), queries
Google Play for each app, and writes the `dashboard` KV key that the gated page at
https://sedx.llc/scratchpad/ reads.

It's deployed **separately** from the Pages site (the Pages build ignores this
subdir). One-time setup below; after that it runs on Cloudflare's schedule.

## Prerequisites
- Account ID: `2cc28133149548e6653b30b50396ae9a`
- A Cloudflare API token that can deploy Workers. Create one at
  **dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"**
  (this template includes Workers Scripts:Edit + Workers KV Storage:Edit). The
  existing `Apps/.cloudflare-token` is KV-only and will NOT work for deploy.

## Deploy
```bash
cd SEDX-site/worker
export CLOUDFLARE_API_TOKEN=<the workers token>
export CLOUDFLARE_ACCOUNT_ID=2cc28133149548e6653b30b50396ae9a

# Secret: the shared service-account key (any app's copy is identical).
# Piping the file handles the multi-line JSON cleanly:
npx wrangler secret put GOOGLE_SA_KEY < ../../Counted/google-service-account.json

# Optional: enable the manual refresh endpoint (otherwise it 404s).
echo "pick-any-long-random-string" | npx wrangler secret put TRIGGER_SECRET

npx wrangler deploy
```

## Verify
```bash
# Watch live logs (cron fires at 00:00, 06:00, 12:00, 18:00 UTC):
npx wrangler tail

# Or trigger immediately if you set TRIGGER_SECRET (replace the host with the
# workers.dev URL printed by `wrangler deploy`):
curl -X POST -H "X-Trigger: <TRIGGER_SECRET>" https://sedx-dashboard-cron.<subdomain>.workers.dev/
```
A successful run writes the `dashboard` KV key with `"source":"cron"`; the page
then shows the new snapshot time.

## Maintenance
- **Adding/renaming an app, or refreshing dev versions:** on the laptop run
  `node SEDX-site/collect-dashboard.js --emit-config`. No Worker redeploy needed —
  it re-reads the config from KV on every run.
- **Change cadence:** edit `crons` in `wrangler.toml`, `npx wrangler deploy`.
- The laptop collector (`node SEDX-site/collect-dashboard.js`) still works for an
  on-demand full refresh; it writes the same `dashboard` key.
