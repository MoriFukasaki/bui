# Security and publishing

Before committing, run `npm run check:publish`, `npm test`, `npm run build`, and `npm audit`. The publish check inspects tracked plus unignored files, rejects generated/private paths and common credential patterns, and compares candidate content with local env credential values without printing matched values. It does not replace GitHub secret scanning or a full security audit.

Do not force-add `.env*` (except the blank `.env.example`), `.neon`, `data/`, `verification/`, build output, recordings or ZIP archives. `data/` includes hashed upload capabilities and metadata; browser IndexedDB includes upload tokens. Keep them private. Back up videos separately. If an actual secret is ever pushed, revoke/rotate it at the provider, then remove it from Git history; deleting the current file alone is insufficient.

The private bucket and Postgres/Realtime credentials belong on the Node server. Never add them to frontend code, public environment prefixes or GitHub Actions logs. CI uses no production Neon credentials and runs offline tests only. Infrastructure project IDs in documentation are identifiers, not authentication credentials.

## Access model and deployment limits

Room codes are bearer invitations: anyone with a code can join and view that room. Only the current host controls recording and remote camera configuration; each camera arms locally. Upload credentials authorize one recording, remain valid for retry while its spool exists, and are not account-level credentials. Private-bucket download URLs expire after five minutes.

This version has no user accounts and allows anonymous room creation with an in-memory rate limit. It does not provide global storage quotas, per-user billing limits, or distributed abuse protection. Before exposing it broadly to untrusted Internet traffic, restrict access/room creation at an authenticated reverse proxy or add app authentication and quotas. Publishing source code to GitHub does not publish the local secrets or deploy the app automatically.

Use HTTPS, preserve authorization/Host headers correctly, disable SSE proxy buffering, and keep the runtime spool outside the public web root on persistent storage. Run one Node instance. A restart closes active rooms. Configure TURN where required; phone browser/OS interruptions and hardware-specific camera settings still need physical-device testing.

If reporting a vulnerability, use the repository's private security reporting feature when enabled. Do not include secrets, live room codes or private videos in a public issue.
