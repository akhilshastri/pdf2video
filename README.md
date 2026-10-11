# pdf2video

Turn a PDF into a short narrated summary video.

1. **Gemini** reads the PDF and writes a scene-by-scene script (`scenes.json`).
2. You can review and edit that script.
3. **Gemini TTS** reads each scene aloud.
4. **ffmpeg** shows the PDF's own pages with a slow zoom and burned-in subtitles, and writes an MP4.

Design, decisions and progress: [plan/01-pdf2video-cli.md](plan/01-pdf2video-cli.md).

## 1. Set up the workspace

You need:

- **Node.js 22 or newer** (`node --version`). npm comes with it.
- **Git**.
- **A Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey) (free tier works).

You do **not** need to install ffmpeg: the `ffmpeg-static` package downloads it during `npm install`.

```sh
git clone https://github.com/akhilshastri/pdf2video.git
cd pdf2video
npm install
```

Put your key in the `GOOGLE_AI` environment variable. Never commit it.

```powershell
# Windows PowerShell — this window only
$env:GOOGLE_AI = "<your key>"

# Windows — permanently for your user (open a NEW terminal afterwards)
[Environment]::SetEnvironmentVariable('GOOGLE_AI', '<your key>', 'User')
```

```sh
# macOS / Linux / Git Bash
export GOOGLE_AI=<your key>
```

Check the setup (no API calls):

```sh
npm run verify      # type-check + unit tests, Gemini is mocked
```

## 2. See it working

Run on the sample PDF that ships with the repo (a 4-page guide to urban beekeeping):

```sh
npx tsx src/cli.ts test/fixtures/sample.pdf --length 30 -o sample.mp4
```

What happens:

1. A one-line notice says the PDF is sent to Google (add `--yes` to hide it).
2. Gemini writes the script. The path of `scenes.json` is printed.
3. **The run pauses.** Open `scenes.json`, edit the narration, page or focus if you like, save, then
   press Enter. (Skip the pause with `--no-review`.)
4. Each scene is spoken, the clips are rendered, and `sample.mp4` is written in the current folder.
   It takes a minute or two for the sample.

Open `sample.mp4` in any video player. Expect about 30 seconds of video with voice and subtitles.

Run the same command again: nothing has changed, so it reuses everything and makes no API calls.

## 3. Use it on your own PDF

```sh
npx tsx src/cli.ts report.pdf                 # full run -> report.mp4
npx tsx src/cli.ts plan report.pdf            # only write scenes.json
npx tsx src/cli.ts voice report.pdf           # only make narration.wav from scenes.json
npx tsx src/cli.ts render report.pdf          # voice (cached) + video, from an existing scenes.json
npx tsx src/cli.ts --help                     # all options
```

| Option | Default | Meaning |
|---|---|---|
| `-o, --out <file>` | `<pdf name>.mp4` | output video |
| `--length <seconds>` | 90 | target video length |
| `--size <WxH>` | 1920x1080 | video size (even numbers) |
| `--lang <code>` | en | narration language |
| `--voice <name>` | Kore | Gemini voice |
| `--no-review` | | do not pause to edit `scenes.json` |
| `--force` | | ignore the cache and redo everything |
| `--yes` | | hide the privacy notice |
| `--work-dir <dir>` | `.pdf2video` | where the cache lives |

## Where files go

Everything except the final video lives in `.pdf2video/<pdf-hash>/`:

| File | What it is |
|---|---|
| `scenes.json` | the script; safe to edit (your edits are never overwritten) |
| `audio/*.wav`, `narration.wav` | one voice file per scene, and all of them joined |
| `pages/`, `stages/`, `clips/` | page images and per-scene video clips |
| `silent.mp4` | the joined clips **without sound**. This is an in-between file, not the result. |
| `subs.ass`, `timings.json` | subtitles and scene timings |

This folder is the cache, so it is always kept: re-runs only redo what changed (for example, editing
one scene's narration re-records only that scene). Delete the folder to start clean.

## Privacy and limits

- The PDF's content is sent to Google Gemini. Don't use it on documents you can't share with Google.
- The free tier allows only about **10 speech requests a day** (one per scene). When the daily quota
  runs out, the run stops with a "resume later" message. Finished scenes are kept, so re-run later
  to continue.
- PDFs over 14 MB are not supported yet.

## Troubleshooting

| Problem | Fix |
|---|---|
| `The GOOGLE_AI environment variable is not set` | set it (step 1). If you set it permanently, open a new terminal. |
| `Gemini daily quota exhausted` | wait for the daily reset (midnight Pacific time), then re-run. |
| `Could not replace <file> (is it open in another program?)` | close the video player, re-run. The finished file was kept at the path shown. |
| ffmpeg not found after `npm install` | run `npm rebuild ffmpeg-static` (install scripts must be allowed). |

## Develop

```sh
npm run verify   # type-check + unit tests (Gemini is mocked)
npm run build    # bundle to dist/cli.js
```
