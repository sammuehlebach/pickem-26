// Pull results and kickoff times from ESPN into data/results.json and data/schedule.json.
// Run by .github/workflows/results.yml; safe to run by hand: `node scripts/update-results.mjs`.
//
// - Only weeks that have started and aren't final are re-scored; final weeks are left alone.
// - Hand-entered fields in results.json (e.g. "adjust") are preserved.
// - Kickoff changes (flexed games) are written to schedule.json, and — when SUPABASE_URL and
//   SUPABASE_SERVICE_ROLE_KEY are set — pushed to the games table so server-side locks follow.
import { readFileSync, writeFileSync } from "node:fs";

const file = (p) => new URL("../" + p, import.meta.url);
const read = (p) => JSON.parse(readFileSync(file(p), "utf8"));
const write = (p, v) => writeFileSync(file(p), JSON.stringify(v, null, 1) + "\n");

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const SEASON = 2026;
const DONE = new Set(["STATUS_FINAL", "STATUS_FINAL_OVERTIME", "STATUS_CANCELED"]);

const schedule = read("data/schedule.json");
const results = read("data/results.json");
const now = Date.now();
let resultsChanged = false, scheduleChanged = false;
const kickoffChanges = [];

async function fetchWeek(week) {
  const url = `${ESPN}?dates=${SEASON}&seasontype=2&week=${week}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "pickem-26 results bot" } });
    if (res.ok) return res.json();
    if (attempt >= 3) throw new Error(`ESPN week ${week}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

for (const wk of schedule) {
  const prev = results[wk.week];
  if (prev && prev.final) continue;
  const data = await fetchWeek(wk.week);
  const events = new Map((data.events || []).map((e) => [e.id, e]));

  // Kickoff drift (flex scheduling) — keep our schedule in step with ESPN.
  for (const g of wk.games) {
    const e = events.get(g.id);
    if (!e || !e.date) continue;
    const iso = new Date(e.date).toISOString();
    if (iso !== g.kickoff) {
      kickoffChanges.push({ id: g.id, week: wk.week, from: g.kickoff, to: iso });
      g.kickoff = iso;
      scheduleChanged = true;
    }
  }
  const times = wk.games.map((g) => Date.parse(g.kickoff));
  wk.firstKickoff = new Date(Math.min(...times)).toISOString();
  wk.lastKickoff = new Date(Math.max(...times)).toISOString();

  if (Date.parse(wk.firstKickoff) > now) continue; // nothing to score yet

  const winners = {}, scores = {};
  let doneCount = 0, mnfTotal = null;
  for (const g of wk.games) {
    const e = events.get(g.id);
    const c = e && e.competitions && e.competitions[0];
    if (!c) continue;
    const status = c.status && c.status.type && c.status.type.name;
    if (!DONE.has(status)) continue;
    doneCount++;
    if (status === "STATUS_CANCELED") { winners[g.id] = "TIE"; continue; }
    const home = c.competitors.find((t) => t.homeAway === "home");
    const away = c.competitors.find((t) => t.homeAway === "away");
    const hs = Number(home.score), as = Number(away.score);
    scores[g.id] = { away: as, home: hs };
    winners[g.id] = hs > as ? "HOME" : as > hs ? "AWAY" : "TIE";
    if (g.id === wk.mnfGameId) mnfTotal = hs + as;
  }
  if (!doneCount) continue;

  const next = {
    ...(prev || {}),
    week: wk.week,
    final: doneCount === wk.games.length,
    mnfTotal,
    winners,
    scores,
  };
  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    results[wk.week] = next;
    resultsChanged = true;
    console.log(`week ${wk.week}: ${doneCount}/${wk.games.length} final${next.final ? " — week complete" : ""}`);
  }
}

if (resultsChanged) write("data/results.json", results);
if (scheduleChanged) {
  write("data/schedule.json", schedule);
  for (const k of kickoffChanges) console.log(`kickoff moved: game ${k.id} (week ${k.week}) ${k.from} -> ${k.to}`);
}

// Keep the database's lock times in step with the schedule.
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  const rows = schedule.flatMap((w) => w.games.map((g) => ({ id: g.id, week: w.week, kickoff: g.kickoff, is_mnf: g.id === w.mnfGameId })));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/games?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`games sync failed: HTTP ${res.status} ${await res.text()}`);
  console.log(`games synced to database (${rows.length})`);
} else {
  console.log("database sync skipped (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)");
}
if (!resultsChanged && !scheduleChanged) console.log("no changes");
