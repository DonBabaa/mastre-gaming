# Add your game to Mastre Gaming

Mastre Gaming is a launcher for browser games made by friends. Your game stays in **your own repo**. The hub clones it, builds it, and serves it at:

```
https://mastre-gaming.github.io/games/<your-id>/
```

inside a frame, on the same website as everyone else's games. To be listed, your repo needs one small file and has to follow a few rules. Gameplay does not change.

## The short version

1. Add a `mastre.json` file and a cover image to your repo.
2. Make the game work from a subfolder (relative paths only).
3. Prefix your storage keys with `mastre:<id>:` and remove any Service Worker.
4. Test it with `npm run check-game` (below).
5. Send the hub owner your repo URL and branch name.

After that, every push to that branch updates the hub by itself, usually within 15 minutes.

> **Using an AI coding assistant?** Open your game's repo in it and paste [docs/port-prompt.md](docs/port-prompt.md). It walks through everything on this page.

## 1. `mastre.json`

Put this at the root of your repo:

```json
{
  "schemaVersion": 1,
  "id": "my-game",
  "title": "My Game",
  "description": "One or two sentences about the game.",
  "authors": ["Your name"],
  "version": "1.0.0",
  "cover": "mastre/cover.png",
  "tags": ["action", "singleplayer"],
  "controls": ["keyboard", "mouse"],
  "build": {
    "install": "npm ci",
    "command": "npm run build",
    "output": "dist"
  },
  "entry": "index.html",
  "multiplayer": { "server": null }
}
```

| Field | Rules |
| --- | --- |
| `schemaVersion` | Always `1`. |
| `id` | Lowercase letters, digits and dashes only (`^[a-z0-9-]+$`). It becomes your URL folder and your storage prefix. It must be unique on the hub and **must never change** once published: a new id is a new game with empty saves. |
| `title`, `description` | Shown on the launcher. Keep the description to one or two sentences. |
| `authors` | At least one name. |
| `version` | Any text you like, e.g. `1.2.0`. |
| `cover` | Path in your repo to a 16:9 image: 1200×675 recommended, PNG, JPG or WebP, under 500 KB. |
| `tags` | Optional. Short words used by the launcher's filters. Stored in lowercase. |
| `controls` | Optional. Any of `keyboard`, `mouse`, `gamepad`, `touch`. |
| `build` | The exact commands that produce a static build on a clean Linux machine with Node 20. `install` and `command` are shell commands; `output` is the folder they produce. |
| `entry` | The HTML file inside `output` that starts the game. |
| `multiplayer.server` | `null`, or the public `wss://` or `https://` URL of your own backend. The hub only hosts static files; it will not run your server. |

**No build step?** For a plain HTML/JS game, set `"build": null`. The repo root is published as it is. If the game sits in a subfolder, add `"output": "that-folder"` next to it.

All paths are relative to the repo root, use forward slashes, and may not start with `/` or contain `..`.

The full contract as a JSON Schema: [schema/mastre.schema.json](schema/mastre.schema.json). To get completion and checks in your editor, add this as the first line of your `mastre.json`:

```json
"$schema": "https://mastre-gaming.github.io/schema/mastre.schema.json",
```

## 2. Make it work from a subfolder

Your game will **not** be at the root of the website. Anything that assumes it is will break.

- Set your bundler's base path to relative. For Vite: `base: './'` in `vite.config`.
- No path may start with `/`. Check `fetch()`, `import()`, `new URL()`, image, audio and model loaders, CSS `url()`, Web Workers, WASM files, and `<link>` and `<script>` tags. Use paths relative to the page, or `import.meta.url`.
- If you use client-side routing, switch to hash routing.
- No hardcoded `localhost` URLs.
- File names are case-sensitive on the server. `Player.png` and `player.png` are different files there, even if they are the same on your computer.

## 3. Share the website nicely

Every game on the hub is on the same origin, so they all share one `localStorage`.

- **Prefix every storage key** with `mastre:<id>:`, for example `mastre:my-game:highscore`. For IndexedDB, name the database `mastre-<id>`. If your game already has players, add a one-time migration from the old keys so nobody loses a save.
- **No Service Worker.** It would take control of every other game too. If you had one, remove it and add code that unregisters the old one.
- **Never clear all storage**, cookies or caches. Only touch your own keys.

## 4. Run inside a frame

- Start audio only after the player's first click, key press or tap inside the game.
- Request fullscreen and pointer lock from an input event inside the game.
- Do not depend on `window.top`, on the parent's URL, or on `document.title`.
- The hub never listens to the keyboard on the game page. Escape and every other key are yours.

Two optional messages make your game feel at home. Both are harmless when the game runs on its own:

```js
// Once the game has loaded: the hub hides its loading screen.
window.parent.postMessage({ type: 'mastre:ready' }, '*');

// When the player picks "Quit": the hub goes back to the list of games.
window.parent.postMessage({ type: 'mastre:exit' }, '*');
```

Without `mastre:ready`, the loading screen leaves as soon as your page has loaded. With it, the hub waits for your message, for up to 10 seconds.

## 5. Keep the repo buildable and public-safe

- The build is published for everyone. No API keys or secrets in client code.
- The build must work from a fresh `git clone`: nothing git-ignored, nothing that only exists on your machine. Submodules and Git LFS files are not downloaded.
- Install and build together get **10 minutes**.
- Keep the output under about **200 MB**, and single files under 50 MB.
- Files and folders starting with a dot are not published.
- Your build runs with no secrets and a minimal environment. It cannot rely on environment variables you set elsewhere.

## 6. Check it before you send it

The hub comes with a checker that does what the real pipeline does: it validates `mastre.json`, runs your build, scans the result for absolute paths and Service Workers, and then serves your game inside the real launcher under a subpath.

```bash
git clone https://github.com/mastre-gaming/mastre-gaming.github.io.git
cd mastre-gaming.github.io
npm install
npm run check-game -- ../my-game
```

It prints a checklist and two links:

- **Play it in the hub**: your game in the launcher's frame, exactly as players will get it. Check input, audio after the first click, fullscreen, saving and loading.
- **The game on its own**: the same build at `/mastre-gaming/games/<id>/`.

Keep an eye on the terminal while you play: every request that fails is printed there. A `404` for a path that does not start with `/mastre-gaming/` is an absolute path that still needs fixing.

Options: `--no-build` uses the build output that is already there, `--no-serve` only prints the report, `--port 5000` changes the port.

## 7. Submit

Send the hub owner:

- your repo URL,
- the branch (or tag) to publish.

They add one line to [`games.json`](games.json):

```json
{ "repo": "your-name/your-game", "ref": "main" }
```

You can also open a pull request that adds that line yourself.

If your repo is private, the easiest path is to make it public; the built game is public anyway. Another option is to keep the repo private but move it into the [mastre-gaming](https://github.com/mastre-gaming) organisation, where the hub can be given read access to it. Talk to the hub owner.

## 8. Updating your game

Just push to the branch you submitted. The hub checks every game repo every 15 minutes and rebuilds the ones that changed. GitHub sometimes runs that schedule a few minutes late.

**If a push breaks your build**, the hub keeps serving your last working version and marks the game "Stale build" until a later push builds again. Nothing else on the hub is affected. The hub owner can see the error in the workflow run.

### Optional: update instantly

If 15 minutes is too slow, your repo can tell the hub the moment you push. Add this file to **your** repo as `.github/workflows/notify-mastre.yml`:

```yaml
name: Notify Mastre hub

on:
  push:
    branches: [main] # the branch listed in the hub's games.json

jobs:
  notify:
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - name: Tell the hub this game changed
        env:
          MASTRE_HUB_TOKEN: ${{ secrets.MASTRE_HUB_TOKEN }}
          GAME_REPO: ${{ github.repository }}
        run: |
          curl --fail-with-body --silent --show-error -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer $MASTRE_HUB_TOKEN" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            https://api.github.com/repos/mastre-gaming/mastre-gaming.github.io/dispatches \
            -d "{\"event_type\":\"game-updated\",\"client_payload\":{\"repo\":\"$GAME_REPO\"}}"
```

It needs a token, stored in your repo as a secret named `MASTRE_HUB_TOKEN`:

1. The **hub owner** creates a fine-grained personal access token: **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Resource owner: the **mastre-gaming** organisation.
   - Repository access: **Only select repositories** → `mastre-gaming.github.io`.
   - Repository permissions: **Contents → Read and write**. (GitHub requires write access to send this kind of event.)
   - Give it an expiry date.
2. If the organisation asks for the token to be approved, they approve it under the organisation's **Settings → Personal access tokens → Pending requests**.
3. They send you the token privately.
4. In **your** repo: **Settings → Secrets and variables → Actions → New repository secret**, name `MASTRE_HUB_TOKEN`, paste the token.

Be aware of what that token is: it can also push to the hub repo, so the hub owner should only hand it to people they would trust with that. Without it, nothing is lost: the 15-minute schedule picks up your changes anyway.

## Sample game

[`examples/sample-game/`](examples/sample-game/) is a tiny complete game that follows every rule here: relative paths, a prefixed storage key, both messages, a build step with no dependencies. `npm run check-game -- examples/sample-game` shows what a passing check looks like.
