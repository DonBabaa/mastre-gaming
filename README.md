# Mastre Gaming

One launcher for browser games made by friends. Every game stays in its own GitHub repo; this repo clones them, builds them, and publishes them together as a single static site on GitHub Pages:

```
https://mastre-gaming.github.io/               the launcher
https://mastre-gaming.github.io/games/<id>/    each game
```

All games share one origin on purpose, so shared logins, profiles and cross-game stats can be added later (see [Roadmap](#roadmap)).

**Want to add your game?** Read [CONTRIBUTING.md](CONTRIBUTING.md).

## Run it locally

Needs Node 20.19 or newer and git.

```bash
npm install
npm run build:all
npm run preview
```

Then open <http://localhost:4380/mastre-gaming/>. The site is served under a subpath on purpose, so anything that wrongly assumes it lives at the domain root breaks here first. The launcher works the same at a domain root and under a subpath.

`build:all` builds the launcher, every game in `games.json`, and the sample game in `examples/sample-game/`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Launcher with hot reload. Shows the games already built into `dist/`. |
| `npm run build` | Type-checks and builds the launcher into `dist/`. |
| `npm run build:games` | Builds the games in `games.json` into `dist/games/`. |
| `npm run build:all` | Launcher, games, and the examples. |
| `npm run preview` | Serves `dist/` at `/mastre-gaming/`. Failed requests are printed. |
| `npm run check-game -- <folder>` | Validates and builds one game folder, then serves it inside the launcher. |
| `npm test` | End-to-end test of the pipeline against throwaway local git repos. |

## Add a game

Add one line to [`games.json`](games.json) and push:

```json
[
  { "repo": "DonBabaa/Deadglide", "ref": "main" },
  { "repo": "a-friend/their-game", "ref": "main" }
]
```

- `repo` is `owner/name` on GitHub.
- `ref` is a branch, a tag, or a full commit sha. Leave it out to follow the repo's default branch.

The game's id, title, cover and build commands come from the `mastre.json` in its own repo, not from here. The contract is described in [CONTRIBUTING.md](CONTRIBUTING.md) and enforced by [`schema/mastre.schema.json`](schema/mastre.schema.json).

After that, nothing else is needed: new commits in a game repo are picked up within about 15 minutes.

## Put it online (once)

1. Push this repo to GitHub. Keep it **public**: GitHub Pages is free for public repos, and so are the Actions minutes the 15-minute schedule uses. The repo's name sets the address: a repo named `<owner>.github.io` is served at `https://<owner>.github.io/`, any other name at `https://<owner>.github.io/<name>/`. This one lives in the `mastre-gaming` organisation as `mastre-gaming.github.io`.
2. On GitHub, open the repo, then **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Open the **Actions** tab, pick **Deploy hub**, and press **Run workflow** (or just push a commit).
4. When the run is green, the site is at `https://mastre-gaming.github.io/`.

Optional settings, under **Settings → Secrets and variables → Actions**:

| Name | Kind | When you need it |
| --- | --- | --- |
| `MASTRE_READ_TOKEN` | Secret | A game repo is private. See below. |
| `MASTRE_HUB_URL` | Variable | The site is on a custom domain. Set it to the full URL, e.g. `https://games.example.com/`. |

### Private game repos

Public game repos need nothing. For private ones, create a fine-grained personal access token (**GitHub → Settings → Developer settings → Fine-grained tokens**) with **Repository access** limited to those game repos and **Contents: Read-only**, and save it as the `MASTRE_READ_TOKEN` secret.

Two things to know:

- A fine-grained token only reaches repos owned by the account or organisation it belongs to. Create it with the **mastre-gaming** organisation as its owner, and it can read private game repos that live in the organisation. For a private repo on a friend's personal account, the simplest fix is to make that repo public, or to move it into the organisation. The built game is published publicly either way.
- The token is only used to download source. It is never present while a game's build commands run.

## How the pipeline works

[`scripts/build-games.mjs`](scripts/build-games.mjs) does the work, in four steps that the workflow runs as separate jobs:

1. **Plan.** For every entry in `games.json`, find the latest commit of its `ref` (`git ls-remote`) and read the `id` from its `mastre.json` at that commit. Ids must be unique; the first entry to claim one keeps it.
2. **Build**, one job per game, in parallel, each on its own machine. If a build of that exact `id` and commit is already cached, it is reused. Otherwise: shallow clone, validate `mastre.json` against the schema, run `build.install` and `build.command` on Node 20 with a 10 minute limit for both together, check that `output/entry` exists, copy the output, and scan it.
3. **Assemble.** Build the launcher with Vite, copy every game to `dist/games/<id>/` and its cover to `dist/covers/<id>.<ext>`, and write `dist/catalog.json`.
4. **Deploy** `dist/` to GitHub Pages.

### One broken game never breaks the site

- If a game fails at any point (repo unreachable, bad manifest, failed or timed-out build, missing entry), its **last successful build is kept** and it is listed with `"stale": true` and the error. The launcher shows a "Stale build" badge.
- If it never built successfully, it is left out, and the reason is in the log and in `catalog.json` under `failed`.
- The script exits 0 either way and ends with a table: **built / reused / stale / failed**. On GitHub the same table is on the run's summary page.
- The one thing that does stop a deploy is the pipeline itself losing track of a game (a build job that never reports back). Then nothing is deployed and the live site stays as it is.

### Warnings

These never fail a build. They are printed, and stored per game in `catalog.json`:

- absolute `/` asset paths in HTML, CSS or JS (they break in a subfolder),
- a build over 200 MB, or a single file over 50 MB,
- a Service Worker registration (it would take over every game on the site),
- `localStorage.clear()` / `sessionStorage.clear()` (it wipes the other games' saves),
- a missing cover, or one over 500 KB.

Files and folders whose name starts with a dot (`.git`, `.env`, ...) and symlinks are never published.

### Caching and the schedule

- Built games are cached with `actions/cache`, one cache per game: key `game-<id>-<sha>`, restore prefix `game-<id>-`. An exact hit means "already built"; a prefix hit is the fallback build used if the new commit fails.
- The workflow runs on a push to `main`, on demand, every 15 minutes, and on a `repository_dispatch` of type `game-updated`.
- The scheduled and dispatched runs first compare every game's current commit with the live `catalog.json`. If no game moved and the hub itself did not change, the run **stops after the plan step** and nothing is built or deployed. A push to `main` or a manual run always deploys.
- A game whose last build failed is retried on the schedule after 6 hours, not every 15 minutes. A full run also happens at least every 5 days so the caches (which GitHub drops after 7 idle days) stay alive.

### `catalog.json`

The launcher reads this file at runtime. Each game carries its manifest fields plus what the pipeline knows about it:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-13T17:42:00.000Z",
  "hub": { "repo": "mastre-gaming/mastre-gaming.github.io", "sha": "…" },
  "games": [
    {
      "id": "deadslide",
      "title": "DeadSlide",
      "description": "…",
      "authors": ["DonBabaa"],
      "version": "0.1.0",
      "tags": ["action", "shooter"],
      "controls": ["keyboard", "mouse"],
      "entry": "index.html",
      "multiplayer": { "server": null },
      "cover": "covers/deadslide.jpg",
      "path": "games/deadslide/",
      "sha": "commit that is being served",
      "builtAt": "…",
      "updatedAt": "date of that commit",
      "stale": false,
      "error": null,
      "sourceRepo": "DonBabaa/Deadglide",
      "sourceRef": "main",
      "attemptedSha": "latest commit the pipeline tried",
      "sizeBytes": 48211003,
      "signals": { "ready": true, "exit": true },
      "warnings": []
    }
  ],
  "failed": [
    { "sourceRepo": "a-friend/broken", "sourceRef": "main", "id": null, "sha": "…", "error": "…", "attemptedAt": "…" }
  ]
}
```

## Security model

Game repos are other people's code, and their build commands run on the build machine. The workflow is set up so that this cannot reach anything that matters:

- The workflow token is **read-only** (`contents: read`) in every job that touches game code. Only the final deploy job has `pages: write`, and it runs no game code.
- Checkouts use `persist-credentials: false`, so no token is left on disk.
- Game builds run in a **separate job per game**, with a small fixed environment (`PATH`, `HOME`, and the like). No secret is passed to the build step, and `MASTRE_READ_TOKEN` only exists in the plan and fetch steps, which download but do not execute anything from the game.
- Manifest paths (`output`, `entry`, `cover`) are checked against the schema and again on disk, so a build cannot publish files from outside its own folder, directly or through a symlink.
- Where files go on the site is decided from the validated `id` only.

What this does not protect against: a game's own JavaScript runs in players' browsers on the same origin as the other games, so it can read their `localStorage`. Only add repos from people you trust. This matters more once shared logins exist (see below).

Running `npm run build:all` or `npm run check-game` locally runs those build commands on your own computer. Same rule.

## Repo layout

```
games.json                      registry: which repos, which ref
schema/mastre.schema.json       the game contract as a JSON Schema
scripts/build-games.mjs         plan, fetch, build, collect
scripts/check-game.mjs          validate and try one local game folder
scripts/serve.mjs               static server under /mastre-gaming/
scripts/test-pipeline.mjs       end-to-end test
scripts/lib/                    shared pieces: git, manifest, runner, scanner, server
src/                            launcher (Vite + TypeScript, no framework)
  index.html, home.ts           the grid
  play.html, play.ts            the page that frames a game
  lib/catalog.ts                catalog types and loading
  lib/messages.ts               messages from a game to the hub
  lib/storage.ts                the hub's own storage (mastre:hub:*)
examples/sample-game/           a tiny game that follows the whole contract
docs/port-prompt.md             a prompt friends can give their AI assistant
.github/workflows/deploy.yml    the pipeline on GitHub Actions
```

## Things worth knowing

- **The schedule is approximate.** GitHub often starts scheduled workflows several minutes late. Friends who want instant updates can add the notify workflow from CONTRIBUTING.md.
- **GitHub pauses schedules in quiet repos.** If this repo gets no commits for 60 days, GitHub disables the scheduled trigger and emails you; re-enable it from the Actions tab.
- **Game ids are permanent.** The id is the URL and the storage prefix. A game that changes its id shows up as a new game and loses its saves.
- **Submodules and Git LFS** are not fetched. A game must build from a plain clone.
- The hub's own browser storage uses the `mastre:hub:` prefix; games use `mastre:<id>:`.

## Roadmap

Not built yet, but the code is laid out for it: shared accounts, friends online, cross-game stats, and a small SDK for games.

**The shape of it.** A small shared backend (for example a serverless function with a database: accounts, sessions, friends, scores) plus a `window.mastre` SDK that the hub gives to every game. Because every game is already on one origin, a single session works everywhere with no cross-site tricks.

**Where each piece goes:**

| Piece | Where it plugs in |
| --- | --- |
| Session and profile | [`src/lib/storage.ts`](src/lib/storage.ts) is the only place the hub touches storage. A session lives under `mastre:hub:session`; later the same functions call the backend. |
| `window.mastre` SDK | Injected by the hub, so games need no dependency: `collectBuild()` in [`scripts/lib/game.mjs`](scripts/lib/game.mjs) is where a `<script>` tag for `sdk.js` gets added to each game's entry page at build time. The SDK is a no-op when a game runs outside the hub. |
| Game ↔ hub protocol | [`src/lib/messages.ts`](src/lib/messages.ts). `mastre:ready` and `mastre:exit` are the first two messages; `mastre:score`, `mastre:presence` and so on are added to the same union and handled in the same listener. The SDK is a thin wrapper that sends them. |
| Friends online, stats | New panels on the home page reading from the backend. The catalog already carries `multiplayer.server`, so "who is playing what" has what it needs. |
| Contract changes | Additive fields in `mastre.json`, with `schemaVersion` bumped only if something breaks. Unknown fields are already tolerated with a warning. |

The play page deliberately uses no `sandbox` on the game frame, so games keep full same-origin access; that is what makes the shared session possible. It is also why only trusted repos belong in `games.json`.
