# Port this game to the Mastre Gaming hub

You are working in the repo of a browser game. Make it compatible with **Mastre Gaming**, a shared launcher that clones this repo, builds it, and serves it at a subfolder like `https://<hub-site>/games/<id>/`, inside an iframe, on the same website as other games.

Do not change gameplay. Only make the changes below, then verify. If something here conflicts with how the game works, stop and explain the conflict instead of guessing.

## 1. Add `mastre.json` at the repo root

```json
{
  "schemaVersion": 1,
  "id": "my-game",
  "title": "My Game",
  "description": "One or two sentences about the game.",
  "authors": ["Name"],
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

Rules:
- `id`: lowercase letters, digits and dashes only. It becomes the URL folder and must never change once published.
- `cover`: 16:9 image (1200×675 recommended), PNG/JPG/WebP, under 500 KB. Create a placeholder at `mastre/cover.png` if none exists and tell me so I can replace it.
- `build`: the exact commands that produce a static build on a clean Linux machine with Node 20. If the game has no build step (plain HTML/JS), set `"build": null` and `"output": "."`.
- `entry`: the HTML file inside `output` that starts the game.
- `controls`: any of `keyboard`, `mouse`, `gamepad`, `touch`.
- `multiplayer.server`: `null`, or the public `wss://` / `https://` URL of the game's own backend. The hub only hosts static files; it will not run your server.

## 2. Make it work from a subfolder

The game will NOT be at the domain root. Fix everything that assumes it is:
- Bundler base path must be relative. For Vite: `base: './'` in `vite.config`. For other bundlers, the equivalent.
- No absolute paths starting with `/`: check `fetch()`, `import()`, `new URL()`, image/audio/model loaders, CSS `url()`, Web Workers, WASM files, `<link>`/`<script>` tags. Use paths relative to the page or `import.meta.url`.
- If the game uses client-side routing, switch to hash routing or make it subfolder-aware.
- No hardcoded `localhost` URLs.
- File names are case-sensitive on the server. Make sure every path matches the real file name exactly.

## 3. Play nicely on a shared website

All Mastre games share one origin, so storage is shared too:
- Prefix every `localStorage` / `sessionStorage` key with `mastre:<id>:` (e.g. `mastre:my-game:highscore`). For IndexedDB, name the database `mastre-<id>`. Add a one-time migration from the old keys so existing saves are not lost.
- Do not register a Service Worker. If one exists, remove it (and add code that unregisters any previously installed one).
- Do not clear all storage, cookies or caches; only touch this game's own keys.

## 4. Run inside an iframe

- Start audio only after the first player input (click/key/tap) inside the game.
- Fullscreen and pointer lock must be requested from a user input event inside the game.
- Do not rely on `window.top`, `window.parent` URLs or changing `document.title` for anything important.
- Optional, recommended: when the player chooses "Quit" / "Back to menu" at the top level, send `window.parent.postMessage({ type: 'mastre:exit' }, '*')`. Also send `{ type: 'mastre:ready' }` once the game has loaded. Both must be harmless when the game runs on its own.

## 5. Public repo hygiene

- The build is public. Remove any API keys or secrets from client code.
- Keep the built output under ~200 MB. Flag any single asset over 50 MB.
- The build must not depend on files that are git-ignored or only on your machine.

## 6. Verify (do all of this, show me the results)

1. Clean install and build using exactly the commands in `mastre.json`.
2. Simulate the hub: copy the build output into `/tmp/mastre-test/games/<id>/` and serve `/tmp/mastre-test` with a static server (e.g. `npx serve /tmp/mastre-test`). Open `/games/<id>/` and confirm: no 404s in the network log, no console errors, assets load, save/load works, audio plays after input.
3. Create `/tmp/mastre-test/play.html` that loads the game in `<iframe src="games/<id>/" allow="fullscreen; gamepad; autoplay">` filling the viewport, and confirm the game is playable there (input, fullscreen, pointer lock if used).
4. Confirm the game still runs normally on its own (`npm run dev` or equivalent).

## 7. Finish

Commit on a branch named `mastre-port`, open a PR (or tell me how to push it), and give me a short summary:
- what you changed,
- the final `mastre.json`,
- anything I need to do (replace the cover, make the repo public or share access with the hub owner, multiplayer server URL).

Then send the repo URL and branch name to the Mastre Gaming hub owner.
