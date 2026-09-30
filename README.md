# Pick'em '26

Office NFL pick'em for the 2026 season. A static page on GitHub Pages, with picks stored in
Supabase and results pulled from ESPN by a scheduled GitHub Action.

- **Players** pick their name, tap a team per game, and enter a Monday-night tiebreaker. Picks
  save as they tap. There is no submit step and no code to send anyone.
- **Locks** are enforced by the database: a pick can't change after its game kicks off, and
  nobody can read anyone else's picks until then.
- **Results** update themselves. `.github/workflows/site.yml` runs every 30 minutes, scores
  finished games into `data/results.json`, commits, and redeploys.

## Layout

| Path | What |
|---|---|
| `index.html`, `app.js`, `style.css` | The page |
| `config.js` | Supabase URL and anon key (public by design) |
| `data/schedule.json` | Season schedule; kickoff times kept current by the workflow |
| `data/players.json` | Roster (the "Playing as" dropdown) |
| `data/results.json` | Winners, scores, MNF totals, commissioner adjustments |
| `supabase/schema.sql` | Tables, read rules, and the `save_sheet` / `my_sheet` / `week_status` functions |
| `scripts/update-results.mjs` | ESPN → results/schedule (+ database lock times) |
| `scripts/build-seed.mjs` | Seed SQL for players, games, and any carried-over picks |

## One-time setup

1. **Supabase:** create a free project. In the SQL editor, run `supabase/schema.sql`, then the
   seed: `node scripts/build-seed.mjs [legacy-picks.json] > private/seed.sql` (`private/` is
   git-ignored, so carried-over future picks never land in the public repo).
2. **config.js:** paste the Project URL and the anon (publishable) key from Project Settings → API.
3. **Repo secrets:** add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The workflow uses them to
   keep the database's lock times in step with flexed kickoffs. Without them, results still
   update, but the server-side locks use the seeded kickoff times.
4. **Pages:** Settings → Pages → Source: *GitHub Actions*. The first push deploys.

## Commissioner tasks

- **Adjust points:** edit `data/results.json` → `"<week>": { "adjust": { "<slug>": { "pts": 10, "note": "why" } } }`
  and commit. The workflow keeps hand-entered fields when it rescores.
- **Add a player:** add them to `data/players.json` and run
  `insert into players(slug, name) values ('first-last', 'First Last');` in the SQL editor.
- **Force a results refresh:** Actions → *Results & deploy* → Run workflow.

Identity is honor-system, like any office pool: the dropdown trusts whoever is holding the phone.
