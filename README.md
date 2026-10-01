# SM64 Coop Web

Self-hosted browser co-op based on SM64 Coop Deluxe. Desktop, touch controls and portrait layouts are supported. The engine is a partial Rust port: input and optionally the original Mario physics/action modules run in Rust; other engine systems remain C/C++.

Each player must provide their **own lawfully obtained, unmodified USA `.z64` ROM**. The browser verifies its SHA-256, saves it in IndexedDB on that device, and reads game assets locally. The ROM is never uploaded, shared with other players, or served by the lobby server. Clearing browser storage removes it; **Remove saved ROM** deletes it explicitly. Private browsing or storage eviction may require importing it again.

No ROM, extracted game assets, vendor source archive, compiled engine, credentials, hosted invite, or existing server configuration is included in this repository. Runtime connections go to the host serving the page. Optional Discord integration uses the operator’s own application.

## Build

Install Node.js 22.13+, Python 3, make, a C/C++ build toolchain, Emscripten (with `emcc` on PATH), and Rust with `wasm32-unknown-unknown` installed. The host also needs its own ROM for the local build validation. Keep the ROM outside the repository.

```sh
npm ci
npm run fetch:engine
rustup target add wasm32-unknown-unknown
SM64_ROM=/path/to/your/SM64-USA.z64 npm run build:engine
npm run build
```

This builds the original C reference engine with the Rust input adapter. Only native UI resources are placed in `shell.data`; ROM sample/music payloads are blank in the executable and loaded from each player’s ROM. The source-assembled sound-player program remains executable. All generated files remain ignored.

For the partial Rust physics engine, install LLVM/Clang 20 with development libraries, then prepare the pinned translator:

```sh
# Set LLVM_CONFIG_PATH and LIBCLANG_PATH if LLVM is not your default.
node scripts/setup-translator.mjs
SM64_RUST_PHYSICS=1 SM64_ROM=/path/to/your/SM64-USA.z64 npm run build:engine
SM64_RUST_PHYSICS=1 SM64_ENGINE_ROOT=private/rust-source-engine npm run build
```

`SM64_PORT_CLANG` can select the Clang executable. Rust translation is experimental; it does not mean the entire game has been ported to Rust.

## Host and invite friends

Generate a private `.env` using a password file outside the repository:

```sh
node scripts/configure-browser.mjs https://your-game.example .env < /path/to/password.txt
npm start
```

The server listens on `127.0.0.1:8790`. Put your own HTTPS reverse proxy in front of it, including WebSocket forwarding. For local testing, configure `http://localhost:8790` instead. HTTPS (or localhost) is required for ROM hashing and browser storage.

For the Rust physics build, add `ENGINE_ROOT=private/rust-source-engine` to `.env`. See `.env.example` for other settings. Persistent worlds are stored in `data/worlds.sqlite`; back up that database. Do not expose `.env`, `vendor`, the build ROM, or the repository root through a web server.

Sign in, import your ROM, create a world and copy its **Invite** link. Friends open that link on your host, sign in and supply their own ROM. The server relays multiplayer state and stores world saves. It cannot establish whether a supplied ROM was lawfully obtained; that remains each player's responsibility.

For a separate server, `node scripts/package.mjs` creates an allowlisted deployment under `private/release`. It includes only the site, server dependencies, WebAssembly engine and UI resources. Create that server’s own `.env` and set `ENGINE_ROOT=engine`; never upload your build ROM or `vendor` directory.

## Discord Activity (optional)

Create your own Discord application, enable Activities and map its URL to your HTTPS host. Configure its credentials and permitted guild/channel IDs using `.env.example`. An Activity uses its voice channel as its lobby; each participant must still import their own ROM in that browser/webview. Browser lobbies work without Discord credentials. Mobile Discord file import and physical-device performance need further testing.

## Checks

```sh
npm test
python3 -m unittest discover -s engine/tests
node scripts/audit-source.mjs
# Install the test browser; then use your own ROM:
npx playwright install chromium
SM64_ROM=/path/to/your/SM64-USA.z64 SM64_HEADLESS=1 npm run test:browser
```

The browser fixture verifies missing-ROM blocking, per-profile import/cache persistence, same-host requests, no ROM upload, two-player movement, host migration and persistent saves. Set `ENGINE_ROOT=private/rust-source-engine` for the Rust build. `SM64_AUDIO_CHECK=1` also checks castle footstep sample mappings against your local ROM.

## Source attribution

Engine sources are fetched separately from [sm64coopdx v1.5.1](https://github.com/coop-deluxe/sm64coopdx/tree/v1.5.1), with the pinned archive hash in `engine.lock.json`. Lua and other dependencies retain their own notices and terms. Nintendo game content is not included. This project is not affiliated with Nintendo.

## License

This repository’s original code is licensed under the [MIT License](LICENSE). Separately fetched upstream engine code and other dependencies retain their own terms; this license grants no rights to Nintendo game content.
