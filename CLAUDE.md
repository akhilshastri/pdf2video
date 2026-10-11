# pdf2video

A Node.js/npm CLI that turns a PDF into a short narrated MP4: Gemini summarizes the PDF into scenes,
Gemini TTS reads them, and ffmpeg renders the PDF's own pages with zoom and subtitles.
The plan, with its decisions and task list, is in `plan/01-pdf2video-cli.md`.

## Commits

This workspace uses numbered commits. Before starting a new change, commit whatever the last change left uncommitted. Each change gets its own commit.

- **Format:** `NNNN: <one-line summary>`, for example `0007: fix empty grid on first load`.
- **Next number:** take the highest existing `NNNN` and add 1. `git log --all -E --grep='^[0-9]{4}: ' --format=%s | sort -r | head -1` shows the latest one. Start at `0001`.
- Git history is the only counter. Don't keep a counter file. Never reuse or renumber a number.
- Before committing, read `git status` and stage files by name. Never stage secrets (`.env`, `*.credentials.json`, keys).
- These are local commits only. Push only when asked.
- `.gitignore` is deny-by-default: a new top-level file or folder must be allowed there explicitly.

## For agents

What every agent brief would otherwise repeat. Agents read this first.

**Runtime:** Node 24 + npm (decision D5: not Bun, for this project). TypeScript run with `npx tsx`, built with `tsup`.

**API key:** read from the `GOOGLE_AI` env var. It's set at Windows *user* level, so a shell that started
earlier may not see it. In PowerShell, load it for one command with
`$env:GOOGLE_AI = [Environment]::GetEnvironmentVariable('GOOGLE_AI','User'); npx tsx scripts/smoke.ts`.
Never print, log or commit the key, and never write it into any file.

**Test tiers:**

| Tier | Command | Typical time |
|---|---|---|
| 1. Fast checks | `npm run verify` (type-check + vitest) | ~10s |
| Smoke (real API, costs quota) | `npx tsx scripts/smoke.ts` | ~20s |
| End-to-end (real API) | `npx tsx src/cli.ts test/fixtures/sample.pdf --no-review --yes` | ~1–3 min |

Only call the real Gemini API when the task needs it. Unit tests must mock `src/lib/gemini.ts`.

**Work dir:** `./.pdf2video/<pdf-hash>/` (ignored by git). Delete it to force a clean run.

**Project rules:** only `src/lib/gemini.ts` imports `@google/genai`. Never log PDF text.
