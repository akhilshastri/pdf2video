# pdf2video

Turn a PDF into a short narrated summary video. Gemini reads the PDF and writes a scene-by-scene
script; Gemini TTS reads it aloud; ffmpeg renders the PDF's own pages with a slow zoom and subtitles.
See [plan/01-pdf2video-cli.md](plan/01-pdf2video-cli.md).

## Setup

Node 22+ and a Gemini API key from [Google AI Studio](https://aistudio.google.com/).

```sh
npm install
# PowerShell:  $env:GOOGLE_AI = "<your key>"
# bash:        export GOOGLE_AI=<your key>
```

## Use

```sh
npx tsx src/cli.ts report.pdf              # plan, pause so you can edit scenes.json, voice, render -> report.mp4
npx tsx src/cli.ts plan report.pdf         # only write scenes.json
npx tsx src/cli.ts voice report.pdf        # only make narration.wav from scenes.json
npx tsx src/cli.ts render report.pdf       # voice (cached) + render, from an existing scenes.json
```

Useful options: `-o, --out <file>` (default `<pdf name>.mp4` in the current folder),
`--size <WxH>` (default 1920x1080, even numbers), `--length <seconds>` (default 90),
`--lang <code>` (default en), `--voice <name>` (default Kore), `--no-review`, `--force`, `--yes`,
`--work-dir <dir>`.

The video ends with the narration. Subtitles are burned in; if that fails, a `.srt` is written
next to the video instead.

The work dir `.pdf2video/<pdf-hash>/` holds `scenes.json`, `audio/*.wav`, `narration.wav`,
`timings.json`, page images and scene clips. It is always kept: it is the cache, so re-runs reuse
anything whose inputs did not change and cost no API calls. There is no `--keep` option; delete
the folder to start clean.

## Privacy and limits

- The PDF's content is sent to Google Gemini. Don't use it on documents you can't share with Google.
- The free tier allows only about 10 TTS requests a day (one per scene). When the daily quota
  runs out, the run stops; progress is kept, so re-run later to continue.

## Develop

```sh
npm run verify   # type-check + unit tests (Gemini is mocked)
npm run build    # dist/cli.js
```
