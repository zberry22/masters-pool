# Masters Pool — Setup Guide

## Local development

### 1. Install Node.js (if not already installed)
Download from https://nodejs.org — use the LTS version (20 or 22).

### 2. Set up the project

```bash
cd masters-pool
cp .env.example .env          # then edit .env and change ADMIN_PASSWORD
npm install
npm start
```

Open http://localhost:3000 in your browser.

---

## Deploying to Railway (recommended — free tier available)

Railway is the easiest way to host this publicly.

### Steps

1. **Create a GitHub repository** and push this project to it:
   ```bash
   git init
   git add .
   git commit -m "Initial Masters Pool"
   # Create a new repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/masters-pool.git
   git push -u origin main
   ```

2. **Sign up at railway.app** (free, use GitHub login).

3. **New Project → Deploy from GitHub repo** → select your repo.

4. **Set environment variables** in Railway dashboard → Variables:
   - `ADMIN_PASSWORD` = (choose a strong password)
   - `DB_PATH` = `/data/pool.db`  ← important! (see step 5)

5. **Add a volume** for the SQLite database:
   - Railway dashboard → your service → Storage → Add Volume
   - Mount path: `/data`
   - This keeps your picks saved across restarts.

6. Railway will give you a public URL like `https://masters-pool-production.up.railway.app`.
   Share that URL with your pool participants.

---

## Deploying to Render

1. Push to GitHub (same as above).
2. Sign up at render.com → New Web Service → connect your repo.
3. Build command: `npm install`
4. Start command: `node server.js`
5. Environment variables: set `ADMIN_PASSWORD` and `DB_PATH=/data/pool.db`
6. Add a Disk (Render dashboard → your service → Disks):
   - Mount path: `/data`
   - Size: 1 GB (minimum, ~$0.25/mo)
   - Without a disk, picks reset on every restart.

---

## Using the app

### Admin page (`/admin.html`)
- Enter your admin password to access.
- Add each participant's name and their 4 golfer picks.
- Golfer names must match the ESPN leaderboard exactly.
  - When the Masters field is announced, load the admin page and the golfer
    autocomplete will populate from the live leaderboard.
  - **Important:** Enter golfer names before the tournament starts using the
    autocomplete, so spelling matches exactly.
- You can edit or delete teams at any time.

### Public standings page (`/`)
- Publicly accessible — share the URL with everyone.
- Auto-refreshes every 60 seconds during the tournament.
- Shows each team's best score per round and overall ranking.
- Click any team row to see a detailed breakdown of each golfer's rounds.

---

## Scoring recap

| Round | Scoring |
|-------|---------|
| R1–R4 | Best (lowest) raw score from your 4 golfers counts |
| Cut/WD | That golfer contributes nothing; team has fewer options |
| Tie | Teams tied on total strokes share the position |
| Winner | Lowest cumulative team score after 4 rounds |

---

## Troubleshooting

**Golfer scores not showing / all zeros**
- The leaderboard API returns data only during tournament week.
- Visit `/api/leaderboard` in your browser to see raw data.
- If ESPN's API is down, the app will fall back to Masters.com's feed.

**A golfer isn't being found / shows "Not found"**
- The name entered doesn't match the leaderboard exactly.
- Go to Admin, edit the team, and re-type the golfer's name using autocomplete.

**Picks disappeared after a restart**
- You need a persistent volume/disk configured (see deploy steps above).
  Without it, Railway/Render restarts wipe the SQLite database file.
