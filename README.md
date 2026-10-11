# pdf2video

Turn a PDF into a short narrated summary. Gemini reads the PDF and writes a scene-by-scene
script; Gemini TTS reads it aloud.

> **Status: MVP.** The AI stages work (PDF → `scenes.json` → narration audio).
> Rendering the video (PDF pages with zoom and subtitles → MP4) is next.
> See [plan/01-pdf2video-cli.md](plan/01-pdf2video-cli.md).

## Setup

Node 22+ and a Gemini API key from [Google AI Studio](https://aistudio.google.com/).

```sh
npm install
# PowerShell:  $env:GOOGLE_AI = "<your key>"
# bash:        export GOOGLE_AI=<your key>
```

## Use

```sh
npx tsx src/cli.ts report.pdf              # plan, pause so you can edit scenes.json, then voice
npx tsx src/cli.ts plan report.pdf         # only write scenes.json
npx tsx src/cli.ts voice report.pdf        # only make narration.wav from scenes.json
```

Useful options: `--length <seconds>` (default 90), `--lang <code>` (default en),
`--voice <name>` (default Kore), `--no-review`, `--force`, `--yes`, `--work-dir <dir>`.

Output goes to `.pdf2video/<pdf-hash>/`: `scenes.json`, `audio/*.wav`, `narration.wav`,
`timings.json`. Re-runs reuse anything whose inputs did not change, so they cost no API calls.

## Privacy and limits

- The PDF's content is sent to Google Gemini. Don't use it on documents you can't share with Google.
- The free tier allows only about 10 TTS requests a day (one per scene). When the daily quota
  runs out, the run stops; progress is kept, so re-run later to continue.

## Develop

```sh
npm run verify   # type-check + unit tests (Gemini is mocked)
npm run build    # dist/cli.js
```
