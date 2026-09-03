/**
 * Pulls standings, WL Moore's games, and every completed result across the
 * whole division from the UYFC division page, and writes all three into the
 * same Firestore database the team-hub site reads from live:
 *   - 'standings'    -> full division table (Standings tab)
 *   - 'auto-games'   -> WL Moore's own schedule (Calendar tab)
 *   - 'game-results' -> every completed game across the division, with final
 *                       scores (Predictions tab — this is new)
 *
 * Run manually: repo → Actions tab → "Sync league standings, schedule &
 * results" → "Run workflow". It also runs automatically on the schedule in
 * the workflow file (.github/workflows/sync-league-data.yml).
 *
 * If the league page's layout changes and this stops finding rows, this file
 * is the one to fix — see parseStandings(), parseSchedule(), and
 * parseAllResults() below. All three read the same schedule table, so if one
 * breaks the others likely will too — that's usually the fastest place to
 * start debugging.
 */

const cheerio = require('cheerio');

// ---- Edit these two lines if your division page or team name ever changes ----
const SOURCE_URL = 'https://www.utahyouthfootball.org/schedule/677551/8bd1';
const OUR_TEAM = 'WL Moore';
// --------------------------------------------------------------------------------

// This is the public Firebase Web API key from team-hub.html — safe to have
// here, it's already visible in the site's own source and is only usable
// within whatever Firestore security rules you've set.
const FIREBASE_PROJECT_ID = 'westlake-team-hub';
const FIREBASE_API_KEY = 'AIzaSyArMPZBlUvKcCvpHhjEw_a5YooRhQH0lrg';

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; team-hub-sync-bot/1.0)' },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const standings = parseStandings($);
  const games = parseSchedule($, OUR_TEAM);
  const results = parseAllResults($);

  console.log(`Parsed ${standings.length} standings rows, ${games.length} games for "${OUR_TEAM}", and ${results.length} completed league results.`);
  if (standings.length === 0) {
    console.warn('WARNING: no standings rows found. The page layout may have changed — check parseStandings().');
  }
  if (games.length === 0) {
    console.warn(`WARNING: no games found for "${OUR_TEAM}". Check OUR_TEAM spelling matches the league page exactly.`);
  }
  if (results.length === 0) {
    console.warn('WARNING: no completed results found. Either it\'s week 1 with nothing played yet, or the page layout changed — check parseAllResults().');
  }

  await writeDoc('standings', {
    divisionLabel: extractDivisionLabel($),
    sourceUrl: SOURCE_URL,
    updatedAt: Date.now(),
    teams: standings,
  });
  console.log('Wrote standings to Firestore.');

  await writeDoc('auto-games', {
    team: OUR_TEAM,
    sourceUrl: SOURCE_URL,
    updatedAt: Date.now(),
    games,
  });
  console.log('Wrote auto-games to Firestore.');

  await writeDoc('game-results', {
    sourceUrl: SOURCE_URL,
    updatedAt: Date.now(),
    games: results,
  });
  console.log('Wrote game-results to Firestore.');

  console.log('Done.');
}

function extractDivisionLabel($) {
  const text = $('body').text();
  const m = text.match(/UYFC Regular Season\s*([A-Z0-9]{3,6})/);
  return m ? m[1] : '';
}

function parseStandings($) {
  const rows = [];
  const tables = $('table').toArray();
  for (const table of tables) {
    const $table = $(table);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_, c) => $(c).text().trim().toLowerCase())
      .get();
    if (headerCells.includes('team') && headerCells.includes('w') && headerCells.includes('l')) {
      const idx = {
        team: headerCells.indexOf('team'),
        w: headerCells.indexOf('w'),
        l: headerCells.indexOf('l'),
        t: headerCells.indexOf('t'),
        gb: headerCells.indexOf('gb'),
        gp: headerCells.indexOf('gp'),
        pct: headerCells.indexOf('pct'),
        streak: headerCells.indexOf('streak'),
        coach: headerCells.indexOf('coach'),
      };
      $table
        .find('tr')
        .slice(1)
        .each((_, tr) => {
          const cells = $(tr)
            .find('td')
            .map((__, c) => $(c).text().trim())
            .get();
          if (cells.length < 3) return;
          const team = cells[idx.team];
          if (!team) return;
          rows.push({
            team,
            w: toInt(cells[idx.w]),
            l: toInt(cells[idx.l]),
            t: idx.t >= 0 ? toInt(cells[idx.t]) : 0,
            gb: idx.gb >= 0 ? cells[idx.gb] : '',
            gp: idx.gp >= 0 ? toInt(cells[idx.gp]) : 0,
            pct: idx.pct >= 0 ? cells[idx.pct] : '',
            streak: idx.streak >= 0 ? cells[idx.streak] : '',
            coach: idx.coach >= 0 ? cells[idx.coach] : '',
          });
        });
      break; // stop after the first matching table (the page repeats it further down)
    }
  }
  return rows;
}

function parseSchedule($, ourTeam) {
  const games = [];
  const tables = $('table').toArray();
  for (const table of tables) {
    const $table = $(table);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_, c) => $(c).text().trim().toLowerCase())
      .get();
    const looksLikeSchedule =
      headerCells.includes('date') &&
      (headerCells.includes('away') || headerCells.includes('home') || headerCells.includes('game'));
    if (!looksLikeSchedule) continue;

    let currentWeek = '';
    $table
      .find('tr')
      .slice(1)
      .each((_, tr) => {
        const cells = $(tr)
          .find('td')
          .map((__, c) => $(c).text().trim())
          .get();
        if (cells.length === 0) return;
        if (cells.length <= 2 && /week/i.test(cells[0] || '')) {
          currentWeek = cells[0];
          return;
        }
        const [dateStr, timeStr, ...rest] = cells;
        if (!dateStr || /week/i.test(dateStr)) return;

        let away, home, location;
        if (headerCells.includes('away') && headerCells.includes('home')) {
          [away, home, location] = rest;
        } else {
          // Combined "Game" column, e.g. "TeamA   TeamB   [LOC]"
          const parts = rest.join(' ').split(/\s{2,}/).filter(Boolean);
          away = parts[0] || '';
          home = parts[1] || '';
          location = parts[2] || '';
        }
        // Cells may have a trailing score once the game's been played
        // (e.g. "WL Moore   20") — strip that off for the schedule view,
        // parseAllResults() below is what captures the score itself.
        away = stripScore(away);
        home = stripScore(home);
        if (away !== ourTeam && home !== ourTeam) return;

        const opponent = away === ourTeam ? home : away;
        const homeAway = away === ourTeam ? 'away' : 'home';
        const isoDate = parseDateStr(dateStr);
        if (!isoDate) return;

        games.push({
          id: `auto_${isoDate}_${slug(opponent)}`,
          week: currentWeek,
          date: isoDate,
          time: normalizeTime(timeStr),
          opponent,
          homeAway,
          location: location || '',
        });
      });
    break; // stop after the first matching table
  }
  return games;
}

// Reads the SAME schedule table as parseSchedule(), but for every game in the
// division rather than just OUR_TEAM's, and keeps the score instead of
// discarding it. Only rows where BOTH teams have a final score are counted
// as a completed result — future/unplayed games are naturally skipped since
// their cells have no trailing number yet.
function parseAllResults($) {
  const results = [];
  const tables = $('table').toArray();
  for (const table of tables) {
    const $table = $(table);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_, c) => $(c).text().trim().toLowerCase())
      .get();
    const looksLikeSchedule =
      headerCells.includes('date') &&
      (headerCells.includes('away') || headerCells.includes('home') || headerCells.includes('game'));
    if (!looksLikeSchedule) continue;

    let currentWeek = '';
    $table
      .find('tr')
      .slice(1)
      .each((_, tr) => {
        const cells = $(tr)
          .find('td')
          .map((__, c) => $(c).text().trim())
          .get();
        if (cells.length === 0) return;
        if (cells.length <= 2 && /week/i.test(cells[0] || '')) {
          currentWeek = cells[0];
          return;
        }
        const [dateStr, timeStr, ...rest] = cells;
        if (!dateStr || /week/i.test(dateStr)) return;

        let awayCell, homeCell;
        if (headerCells.includes('away') && headerCells.includes('home')) {
          [awayCell, homeCell] = rest;
        } else {
          const parts = rest.join(' ').split(/\s{2,}/).filter(Boolean);
          awayCell = parts[0] || '';
          homeCell = parts[1] || '';
        }

        const away = splitNameScore(awayCell);
        const home = splitNameScore(homeCell);
        if (!away || !home || away.score == null || home.score == null) return; // not played yet

        results.push({
          id: `result_${slug(away.name)}_vs_${slug(home.name)}_${dateStr}`.replace(/\s+/g, '_'),
          teamA: away.name,
          scoreA: away.score,
          teamB: home.name,
          scoreB: home.score,
          label: currentWeek || dateStr,
        });
      });
    break; // stop after the first matching table
  }
  return results;
}

// "WL Moore   20" -> { name: "WL Moore", score: 20 }
// "LH Darling" (no score yet)      -> { name: "LH Darling", score: null }
function splitNameScore(cellText) {
  if (!cellText) return null;
  const collapsed = cellText.replace(/\s+/g, ' ').trim();
  const m = collapsed.match(/^(.*\S)\s+(\d+)$/);
  if (m) return { name: m[1].trim(), score: parseInt(m[2], 10) };
  return { name: collapsed, score: null };
}
function stripScore(cellText) {
  const parsed = splitNameScore(cellText || '');
  return parsed ? parsed.name : (cellText || '');
}

function toInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function parseDateStr(s) {
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return '';
  const now = new Date();
  let year = now.getFullYear();
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  // If this date would land more than ~2 months in the past, assume it's next year
  // (handles a season that starts before Jan 1 relative to when this runs).
  const guess = new Date(year, month - 1, day);
  const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, now.getDate());
  if (guess < twoMonthsAgo) year += 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function normalizeTime(s) {
  const m = String(s).match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const min = m[2];
  const pm = /P/i.test(m[3]);
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

// ---- Firestore REST write (same "teamhub/{docId}" doc shape the site reads) ----
async function writeDoc(docId, value) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/teamhub/${docId}?key=${FIREBASE_API_KEY}`;
  const body = { fields: { value: toFirestoreValue(value) } };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore write failed for "${docId}": ${res.status} ${text}`);
  }
}
function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, toFirestoreValue(val)])),
      },
    };
  }
  return { stringValue: String(v) };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
