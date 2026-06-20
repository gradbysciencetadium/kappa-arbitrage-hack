# Deploy to Render (free)

The app is ready to deploy. `.env` and `node_modules` are gitignored; the Croydon data
(`src/data/cache/croydon.json`) IS committed so the live app reads it without ingestion.

## 1. Push this folder to GitHub
This folder is already a git repo with an initial commit. Create an **empty** repo on GitHub, then:
```
git remote add origin https://github.com/<you>/kappa-arbitrage.git
git branch -M main
git push -u origin main
```

## 2. Create the Render service
- render.com → **New ▸ Blueprint** → connect the repo. Render reads `render.yaml`
  (free plan, `npm install` / `npm start`).
- (Or **New ▸ Web Service** manually: Runtime Node, Build `npm install`, Start `npm start`, Free plan.)

## 3. Set the secret env vars (Render dashboard → Environment)
Do NOT commit these — paste them in Render:
- `FLOCK_API_KEY` = your FLock key
- `SUPABASE_URL` = https://tsyldumqspnceihefgyq.supabase.co
- `SUPABASE_KEY` = your Supabase service_role key
- `GEMINI_API_KEY` = (optional fallback)
`FLOCK_MODEL` and `SOVEREIGN_AI=1` are already in `render.yaml`. Render sets `PORT` automatically.

## 4. Deploy
Render builds and gives you `https://kappa-arbitrage.onrender.com`. Open `/` for the
consultation and `/governance.html` for the audit ledger.

## Demo notes
- **Free tier sleeps after ~15 min idle** → first hit cold-starts in ~30–60s. **Warm it up** by
  opening the URL a minute before you present (or switch to the ~$7/mo instance for the event).
- Don't run data ingestion on the free box (512 MB RAM) — the Croydon dataset is already committed.
- **Rotate your Supabase + FLock keys after the hackathon** (they were shared during setup).
