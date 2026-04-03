require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'masters2026';
const PAR_PER_ROUND = 72; // Augusta National par

// ---------------------------------------------------------------------------
// JSON file database (no native dependencies)
// ---------------------------------------------------------------------------
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'pool.json');

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { teams: [], nextId: 1 };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!pw || pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Leaderboard fetching & parsing
// ---------------------------------------------------------------------------
let cache = { data: null, timestamp: 0, source: null };
const CACHE_TTL = 60 * 1000; // 1 minute

async function fetchLeaderboard() {
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache;
  }

  // -- Try ESPN undocumented API (no key required) --------------------------
  try {
    const res = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
    );
    if (res.ok) {
      const json = await res.json();
      const players = parseESPN(json);
      if (players.length > 0) {
        cache = { data: players, timestamp: Date.now(), source: 'ESPN' };
        return cache;
      }
    }
  } catch (err) {
    console.warn('ESPN fetch failed:', err.message);
  }

  // -- Try Masters.com feed (unofficial, may change year-to-year) -----------
  try {
    const year = new Date().getFullYear();
    const res = await fetch(
      `https://www.masters.com/en_US/scores/feeds/${year}/scores.json`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
    );
    if (res.ok) {
      const json = await res.json();
      const players = parseMasters(json);
      if (players.length > 0) {
        cache = { data: players, timestamp: Date.now(), source: 'Masters.com' };
        return cache;
      }
    }
  } catch (err) {
    console.warn('Masters.com fetch failed:', err.message);
  }

  // Return stale cache rather than nothing
  return cache;
}

// Parse a to-par string like "-5", "+3", "E" → integer
function parseToPar(str) {
  if (!str || str === 'E' || str === 'even') return 0;
  const n = parseInt(String(str).replace('+', ''));
  return isNaN(n) ? 0 : n;
}

function parseESPN(data) {
  try {
    const events = data.events || [];
    const event =
      events.find(e =>
        (e.name || '').toLowerCase().includes('masters') ||
        (e.shortName || '').toLowerCase().includes('masters')
      ) || events[0];

    if (!event) return [];

    const competition = (event.competitions || [])[0];
    if (!competition) return [];

    return (competition.competitors || []).map(c => {
      const linescores = c.linescores || [];

      // ESPN's linescores[i].displayValue is already the correct to-par string
      // for every round — completed ("-4") and in-progress ("-1") alike.
      // linescores[i].value is raw strokes for completed rounds but partial
      // accumulated strokes for in-progress — so we never use .value.
      const rounds = linescores.map(ls => {
        const dv = ls.displayValue;
        if (!dv || dv === '--' || dv === '') return null;
        return parseToPar(dv);
      });

      // Pad to 4 slots
      while (rounds.length < 4) rounds.push(null);

      const statusDesc = (c.status?.type?.description || '').toLowerCase();
      const isCut = statusDesc.includes('cut');
      const isWD  = statusDesc.includes('withdrawn') || statusDesc.includes('wd');

      // True total to-par including in-progress round comes from statistics
      const scoreToParStat = (c.statistics || []).find(s => s.name === 'scoreToPar');
      const toParStr = scoreToParStat?.displayValue || c.score?.displayValue || 'E';

      return {
        name:     c.athlete?.displayName || 'Unknown',
        espnId:   c.athlete?.id || String(c.id),
        position: c.status?.position?.displayName || '-',
        rounds,   // to-par per round (e.g. -4, 0, +2, or null)
        toParStr,
        thru:     c.status?.thru != null ? String(c.status.thru) : 'F',
        status:   isCut ? 'CUT' : isWD ? 'WD' : 'ACTIVE',
      };
    });
  } catch (err) {
    console.error('ESPN parse error:', err);
    return [];
  }
}

function parseMasters(data) {
  try {
    const raw = data?.data?.player || data?.player || [];
    return raw.map(p => {
      const rounds = [p.r1, p.r2, p.r3, p.r4].map(r => {
        if (!r || r === '--' || r === 'CUT' || r === 'WD' || r === 'MDF') return null;
        const n = Number(r);
        return isNaN(n) ? null : n;
      });
      const statusCode = (p.status || '').toUpperCase();
      return {
        name:     `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.player || 'Unknown',
        espnId:   String(p.player_id || p.id || ''),
        position: p.pos || '-',
        rounds,
        toParStr: p.topar || p.to_par || p.tot || 'E',
        thru:     p.thru || 'F',
        status:   statusCode === 'C' || p.pos === 'CUT' ? 'CUT'
                : statusCode === 'W' ? 'WD'
                : 'ACTIVE',
      };
    });
  } catch (err) {
    console.error('Masters.com parse error:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Standings calculation
// ---------------------------------------------------------------------------
function normalise(name) {
  return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function findPlayer(name, playerMap) {
  const key = normalise(name);
  if (playerMap[key]) return playerMap[key];

  // Try matching on last name only as a fallback
  const lastName = key.split(' ').pop();
  for (const [k, v] of Object.entries(playerMap)) {
    if (k.endsWith(lastName)) return v;
  }
  return null;
}

function toParLabel(totalToPar, roundsPlayed) {
  if (roundsPlayed === 0) return '-';
  if (totalToPar === 0) return 'E';
  return totalToPar > 0 ? `+${totalToPar}` : String(totalToPar);
}

function calculateStandings(teams, players) {
  const playerMap = {};
  for (const p of players) {
    playerMap[normalise(p.name)] = p;
  }

  const results = teams.map(team => {
    const golferNames = [team.golfer1, team.golfer2, team.golfer3, team.golfer4];
    const golferData  = golferNames.map(n => findPlayer(n, playerMap));

    // For each of the 4 rounds, take the best (lowest) score from any golfer
    const roundBests = [0, 1, 2, 3].map(ri => {
      const scores = golferData
        .filter(Boolean)
        .map(g => g.rounds[ri])
        .filter(s => s !== null && s !== undefined);
      if (scores.length === 0) return null;
      const best = Math.min(...scores);
      // which golfer had it?
      const contributor = golferData.find(
        g => g && g.rounds[ri] === best
      );
      return { score: best, contributor: contributor?.name || '' };
    });

    const validRounds  = roundBests.filter(r => r !== null);
    const totalToPar   = validRounds.reduce((s, r) => s + r.score, 0);
    const roundsPlayed = validRounds.length;

    return {
      id:        team.id,
      ownerName: team.owner_name,
      golfers: golferNames.map((name, i) => {
        const g = golferData[i];
        return {
          name,
          found:    !!g,
          status:   g?.status   || 'UNKNOWN',
          position: g?.position || '-',
          rounds:   g?.rounds   || [],
          toParStr: g?.toParStr || '-',
          thru:     g?.thru     || '',
        };
      }),
      roundBests,
      totalToPar,
      roundsPlayed,
      toParLabel: toParLabel(totalToPar, roundsPlayed),
    };
  });

  // Sort by total to-par (lower = better); unstarted teams last
  results.sort((a, b) => {
    if (a.roundsPlayed === 0 && b.roundsPlayed === 0) return 0;
    if (a.roundsPlayed === 0) return 1;
    if (b.roundsPlayed === 0) return -1;
    return a.totalToPar - b.totalToPar;
  });

  // Assign positions (handle ties)
  let pos = 1;
  for (let i = 0; i < results.length; i++) {
    if (i > 0 && results[i].totalToPar !== results[i - 1].totalToPar) {
      pos = i + 1;
    }
    results[i].position = results[i].roundsPlayed === 0 ? '-' : pos;
  }

  return results;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Public: current Masters leaderboard (for golfer autocomplete / debug)
app.get('/api/leaderboard', async (req, res) => {
  const c = await fetchLeaderboard();
  res.json({ players: c.data || [], source: c.source, lastUpdated: c.timestamp });
});

// Debug: raw ESPN response for first 3 competitors
app.get('/api/debug-espn', async (req, res) => {
  try {
    const r = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
    );
    const json = await r.json();
    const events = json.events || [];
    const event = events.find(e => (e.name||'').toLowerCase().includes('masters')) || events[0];
    const competitors = event?.competitions?.[0]?.competitors?.slice(0, 3) || [];
    res.json({ eventName: event?.name, competitors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: pool standings
app.get('/api/standings', async (req, res) => {
  const { teams } = readDB();
  const c = await fetchLeaderboard();
  const standings = calculateStandings(teams, c.data || []);
  res.json({
    standings,
    source:      c.source,
    lastUpdated: c.timestamp,
    playerCount: (c.data || []).length,
    roundsInProgress: standings.some(s => s.roundsPlayed > 0),
  });
});

// Public: all teams
app.get('/api/teams', (req, res) => {
  const { teams } = readDB();
  res.json([...teams].sort((a, b) => a.owner_name.localeCompare(b.owner_name)));
});

// Admin: add team
app.post('/api/teams', requireAdmin, (req, res) => {
  const { owner_name, golfer1, golfer2, golfer3, golfer4 } = req.body;
  if (!owner_name || !golfer1 || !golfer2 || !golfer3 || !golfer4) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  const db = readDB();
  const nameTaken = db.teams.some(t => t.owner_name.toLowerCase() === owner_name.trim().toLowerCase());
  if (nameTaken) return res.status(409).json({ error: 'A team with that name already exists.' });
  const team = {
    id: db.nextId++,
    owner_name: owner_name.trim(),
    golfer1: golfer1.trim(),
    golfer2: golfer2.trim(),
    golfer3: golfer3.trim(),
    golfer4: golfer4.trim(),
    created_at: new Date().toISOString(),
  };
  db.teams.push(team);
  writeDB(db);
  res.json({ id: team.id });
});

// Admin: edit team
app.put('/api/teams/:id', requireAdmin, (req, res) => {
  const { owner_name, golfer1, golfer2, golfer3, golfer4 } = req.body;
  const id = parseInt(req.params.id);
  const db = readDB();
  const idx = db.teams.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Team not found.' });
  db.teams[idx] = { ...db.teams[idx], owner_name: owner_name.trim(), golfer1: golfer1.trim(), golfer2: golfer2.trim(), golfer3: golfer3.trim(), golfer4: golfer4.trim() };
  writeDB(db);
  res.json({ success: true });
});

// Admin: delete team
app.delete('/api/teams/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  db.teams = db.teams.filter(t => t.id !== id);
  writeDB(db);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Masters Pool running on http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
