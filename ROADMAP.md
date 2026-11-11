# Snap Count roadmap

The owner wants the best fantasy football app there is and doesn't want to have to ask for each improvement.
An automatic build session picks the top unchecked item, ships it, and checks it off.

## How to ship
- App: `src/index.html` (single page), Worker: `src/worker.src.js`, alerts/cron: `src/alerts.js`, integrations/AI: `src/more.js`.
- Build with `node build.js && node --check worker.js`. Also syntax-check the inline `<script>` in `src/index.html`.
- Push to `main` on github.com/g24man44/snapcount; Cloudflare Workers Builds deploys it. Confirm the check run passes.
- Owner's real league: Fleaflicker league 183120, team 1245245 ("Bumblebee tuna"), 16 teams, dynasty superflex, 18 keepers.
- Never break what works. Test in a headless browser against real Fleaflicker data before pushing. If tests fail, don't push.

## Next up (top first)
- [ ] Refresh src/prospects.js with the newest public 2027 rookie boards (superflex and 1QB) about every two weeks; after the NFL draft switch the rookie mock to drafted rookies with landing spots.

## Blocked (needs the owner)
- [ ] Save lineups straight to Fleaflicker and Sleeper: neither has a public way for other apps to change lineups. Fleaflicker would need a sample of the request its site sends when you move a player (from the browser's network tab while signed in).
- [ ] Yahoo leagues: needs a Yahoo developer app (client ID and secret) for sign-in.
- [ ] Draft picks in "Send in Fleaflicker": needs a sample trade-builder link that includes a pick.

## Done
- [x] Voice like Claude dictation: record with live waveform and timer, tap ✓ to transcribe (Whisper on Workers AI, roster names as hints), text lands in the box, send with Ask; works on iPhone
- [x] Rookie mock draft (Calc › Mock draft › Dynasty › Rookie draft): 2027 college class from a consensus of public rookie boards (src/prospects.js — refresh as new boards publish), your league's projected pick order with traded picks, computer teams draft by rank and roster need, grades vs pick value
- [x] Playoff picture (Leagues › League): bracket if the season ended today (division winners, byes), the race with odds/projected wins/likely seed and the playoff line, this week's highest-leverage games and who to root for
- [x] Projected draft order (Leagues › League): every pick for next year's draft by simulated finish, traded picks tracked, your picks with likely range and value
- [x] Mock draft (Calc › Mock draft): draft against computer teams in any format (dynasty startup or redraft, 1QB/superflex, 8–16 teams, any slot, 8–20 rounds), your league's team names, best-pick suggestion, auto-draft, grades for every team, share
- [x] Trade calculator tab (Calc): any players and picks, any format (dynasty/redraft, 1QB/superflex, PPR, 8–20 teams), works without a league, verdict and balance bar, one-tap "even it out" suggestions, shareable link that opens the same trade for anyone
- [x] Coach voice input keeps listening until you tap the mic again; nothing sends until you tap Ask
- [x] Broadcast redesign: stadium navy + scoreboard gold, Archivo (self-hosted, condensed headlines, wide tabular numbers), scorebug matchups, drawn icons instead of emoji, action tiles, skeleton loading, sheets slide up and swipe down, screen transitions, new app icon
- [x] Snap Count value: trade values blend FantasyCalc market (50%), FantasyPros expert consensus via DynastyProcess (25%) and this season's production weighted to recent weeks (25%; 60/40 market/production in redraft); breakdown card on every player; set your own value and it carries everywhere; superflex QB bump no longer double-counted for 16-team leagues
- [x] Game log on every player (tap any player › Game log): week-by-week fantasy points chart with byes and missed games, opponent, weekly position rank, snap share and box-score line, plus per game, last 3, floor, best and how often he finished as a startable week (“Steady starter”, “Boom or bust”…), in PPR, half PPR or standard. Compare players now shows startable weeks and floor/best week too, and the AI verdict uses them
- [x] Playoff path (Leagues › League › Playoff path, Edge › League): your playoff odds with the record you need to get in, every remaining game's swing (win → X%, loss → Y%) with the biggest game flagged, and who to root for in this week's other games (same simulated seasons replayed with just that game flipped). Playoff odds now count live and final scores from the week in progress
- [x] Team close-up in League landscape: tap any dot on the map, any team in the position table, or “See their roster” on a trade partner to see that team’s position ranks, what it needs (thin positions, hurt starters, contend/rebuild wants) and what you could offer, the players it could spare and why, its full roster with values and ages, and one tap to ask for a player or build a trade
- [x] Sell a player (Trade › Sell): your best sell candidates (age, depth, value trend, your contend/rebuild status), every team ranked by how much he helps them, a fair return to ask for from each with value range, grade and acceptance odds, one tap to send
- [x] Sleeper, Fleaflicker, ESPN, MyFantasyLeague leagues
- [x] Push alerts, Discord/Slack/Teams/Telegram/ntfy/IFTTT/Zapier/Make webhooks, calendar feed
- [x] Trade grader, acceptance odds, trade finder, price finder, share-image cards
- [x] Edge tab (start/sit, waivers, playoff odds, dynasty, keepers)
- [x] AI coach (voice, streaming), AI weekly recap (manual + Tuesday auto-post)
- [x] Live win probability, every-sport scores, offline mode, app shortcuts, app badge
- [x] Sunday 11:00 ET AI pregame briefing: push + Discord/Slack post with start/sit calls, risky starters, best pickup (Alerts › Sunday pregame briefing, with preview)
- [x] League trade report card: every trade in the league graded A+ to F for each side, best/worst traders, most lopsided deals, all-time history (Leagues › your league › Trades)
- [x] Waiver bids: FAAB bid and range for the top free agents (your budget, rivals' budgets, value, week), or claim-vs-wait advice in waiver-priority leagues (Edge › Waivers)
- [x] League history & rivalries: every season's games, head-to-head for any team (nemesis, favorite victim, fiercest rivalry), champions, all-time standings, record book (Leagues › League › League history)
- [x] Player comparison: 2–4 players side by side (projection, matchup, team total, points per game, snaps, usage, dynasty and season values, rank, trend, age, who owns him) with an AI verdict (Trade tab, or Compare on any player)
- [x] Rest-of-season strength of schedule: week-by-week matchup difficulty for each starter (points allowed to his position), playoff weeks flagged, plus your remaining fantasy opponents (Edge › League)
- [x] Draft center: every league draft graded with hindsight (team grades, steals, busts, top-12 re-draft) (Edge › Dynasty); traded picks in trade grades now resolve to the player drafted, including this season's draft
- [x] Negotiate mode: practice a trade pitch against an AI playing the other manager (their roster, record, needs, values), then send the deal (Trade › Grade › Practice the pitch)
- [x] Accessibility and light-theme pass: zero automated WCAG A/AA violations across every screen in light and dark mode (stronger light-mode colors, labels, keyboard focus into and out of sheets)
- [x] Power rankings with schedule luck: scoring, recent form and all-play record, week-over-week movement, luckiest/unluckiest/hottest, share or post to Discord (Leagues › League)
- [x] Trade alerts now carry grades: every new league trade pushed/posted with a letter per side and a verdict
- [x] Sweat board: every starter in every league, live points vs projection, grouped by playing now / still to play / done, each league's score and win odds, refreshes every minute (Leagues › Sweat board)
- [x] Live draft board: when a draft is scheduled or under way, Draft center shows your next pick, who picks before you, best available by value with position filters, and the next 12 picks
- [x] Friday noon ET matchup preview (push + connected apps): projected score and win odds, their threats, your best, injured starters on both sides, lineup holes
- [x] Tuesday power rankings auto-post to each Fleaflicker league's connected Discord/Slack after the AI recap
- [x] Lineup editor: set your lineup in the app (tap a slot, pick a player, or Best lineup). Saves straight to ESPN (with espn_s2/SWID) and MyFantasyLeague (sign in once); Fleaflicker and Sleeper get a move-by-move checklist and a link
- [x] League landscape: map of every team as Powerhouse / All-in / On the rise / Rebuild (dynasty) or by roster vs scoring (redraft), every team's rank at each position and in picks, and your 3 best trade partners with who to ask about and what to offer, one tap to build the trade (Leagues › League, Edge › League)
- [x] Bye-week & injury planner: lineup holes for the next 4 weeks in every league (byes, injured reserve, PUP, suspensions, players ruled out or doubtful), a color-coded week strip, the bench fill for each open spot with that week's opponent, and the best free agent when he beats your bench, plus the best pickups to cover several weeks (Leagues › Bye & injury planner, Edge › Week)
