# Chapters 📖

A distraction-free, mobile-first writing app for books. Each chapter is a plain
`.txt` file stored in a GitHub repository — no database, no backend, no lock-in.
Your manuscript is just text files with full version history.

**Pure static frontend**: HTML + CSS + vanilla JS (ES modules), zero build step,
zero dependencies. The browser talks directly to the GitHub REST API. Host it on
GitHub Pages (or any static host) and install it to your phone's home screen as
a PWA.

## Features

- ✍️ Big, comfortable editor tuned for phones (safe-area aware, no zoom traps)
- 🧘 Focus mode — hides everything but your text
- 🔤 Typography controls: serif/sans/mono, size, line height, line width
- 🌗 Dark & light themes (follows your system, or force either)
- 📊 Live word count, character count and reading time
- 💾 Continuous autosave to the device (IndexedDB) — nothing is ever lost
- ⬆️ Explicit **Commit** button with an editable commit message
- 🔀 Conflict detection: if a chapter changed on GitHub, choose overwrite or reload
- ✈️ Full offline support: keep writing offline, commits queue until you reconnect
- 📤 Web Share fallback to hand a chapter's `.txt` to any app

## Setup

### 1. Create a repository for your book

Any repo works — private is recommended. Chapters live as `.txt` files, either
at the repo root or in a folder you choose (e.g. `manuscript/`).

### 2. Create a fine-grained Personal Access Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) →
   **Fine-grained tokens** → **Generate new token**.
2. **Repository access**: choose *Only select repositories* and pick just your
   book's repo.
3. **Permissions → Repository permissions**: set **Contents** to
   **Read and write**. Leave everything else at *No access*.
4. Pick an expiration you're comfortable with, generate, and copy the token
   (it looks like `github_pat_…`).

> **Security note.** The token is kept in your browser's `localStorage` on the
> device where you enter it, and is only ever sent directly to
> `api.github.com` over HTTPS. Still, treat it like a key to that repo: scope
> it to the single repository, and revoke it from GitHub settings if you lose
> the device.

### 3. Configure the app

Open the app. The first-run screen asks for:

| Field  | Meaning                                             | Example       |
| ------ | --------------------------------------------------- | ------------- |
| Token  | The fine-grained PAT from step 2                     | `github_pat_…`|
| Owner  | The user or org that owns the repo                   | `janeauthor`  |
| Repo   | Repository name                                      | `my-novel`    |
| Branch | Branch to read/write (default `main`)                | `main`        |
| Folder | Optional folder for chapters, empty = repo root      | `manuscript/` |

The folder doesn't need to exist yet — GitHub creates it with your first
committed chapter. You can change all of this later under **Settings** in the
chapter drawer.

## Writing workflow

- Everything you type is **autosaved to the device** within a second. The
  status bar shows *Saved HH:MM* and a colored dot:
  green = in sync with GitHub, amber = uncommitted local changes,
  red = a commit is queued (offline).
- Tap **Commit** (or press `Ctrl/Cmd+S`) when you want to push a snapshot to
  GitHub. Edit the commit message if you like.
- If you're offline, the commit is queued; when you're back online a toast
  offers **Commit now**.
- New chapters get suggested filenames like `03-the-long-road-home.txt` so
  they sort naturally.

## Deploying to GitHub Pages

The app itself is static, so the easiest setup is a second repo (or the same
one, if you don't mind the app living next to your manuscript):

1. Push these files to a repo (e.g. `chapters-app`).
2. In the repo: **Settings → Pages → Source: Deploy from a branch**, pick
   `main` and `/ (root)`, save.
3. Your app appears at `https://<username>.github.io/chapters-app/` after a
   minute. All paths in the app are relative, so subdirectory hosting works
   out of the box.
4. Open it on your phone and use *Add to Home Screen* / *Install app* to get
   the standalone PWA experience.

> **Note.** GitHub Pages sites are public even for private repos on free
> plans. That's fine — the app contains no secrets; your token stays on your
> device. Your *manuscript* repo can stay private.

### Updating the app

The service worker caches the app shell for offline use. When you change any
shell file, bump the `VERSION` constant at the top of [sw.js](sw.js) so
installed clients fetch the new files on their next launch.

## File structure

```
index.html            App shell: setup screen, editor, drawer, dialogs
styles.css            Mobile-first styles, light/dark themes, focus mode
manifest.webmanifest  PWA manifest
sw.js                 Service worker (offline app shell)
js/
  app.js              Entry point & orchestration
  github.js           GitHub REST client + UTF-8-safe base64 helpers
  storage.js          localStorage settings + IndexedDB drafts
  editor.js           Typography, word counts, autosave debouncing
  ui.js               Theme, drawer, toasts, focus mode, dialogs
  setup.js            First-run / settings screen
icons/                App icons (SVG source + generated PNGs)
```

## Development

No tooling needed. Serve the folder over HTTP (service workers require it):

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

## License

Do whatever you like with it. Happy writing!
