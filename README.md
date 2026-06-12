# Whisper – fully in-browser transcription

A static web app that records or uploads audio and transcribes it with Whisper **entirely inside the browser**. There is no backend: the model runs locally via [Transformers.js](https://github.com/huggingface/transformers.js) on WebGPU (with WebAssembly fallback), and all transcripts and recordings are stored in the browser's IndexedDB. No audio or text ever leaves the machine.

A second local model ([Web-LLM](https://github.com/mlc-ai/web-llm) running Qwen2.5 1.5B Instruct over WebGPU) can extract a transcript into a structured **medical form** with clinician-editable fields — also fully in-browser.

## Quick start

Serve the folder with any static file server, e.g.:

```powershell
python -m http.server 8000
# or
npx serve .
```

Then open http://localhost:8000. The microphone only works on `localhost` or HTTPS.

## How it works

- **Models**: `onnx-community/whisper-base` (default, ~80 MB) or `onnx-community/whisper-small` (~250 MB, better Dutch/multilingual accuracy). Downloaded from Hugging Face on first transcription, then cached by the browser — subsequent use works fully offline.
- **Engine**: WebGPU when the browser/GPU supports it (Chrome/Edge), otherwise WebAssembly on the CPU (slower).
- **Languages**: auto-detect, or force Dutch/English from the dropdown.
- **Storage**: transcripts and their audio live in IndexedDB on this device only. Unsaved recordings are kept in memory and lost on refresh.
- **Form filling**: the "Fill form" button feeds the transcript to `Qwen2.5-1.5B-Instruct` (4-bit, ~900 MB, downloaded on first use then cached) running in a Web Worker via Web-LLM. The model is forced into JSON-schema mode at temperature 0, so it can only output the fields defined in the editable template; empty fields stay empty rather than being invented. Filled forms are stored with their transcript, included in `.txt` downloads, and exportable as `.json`. Requires WebGPU — without it the button is disabled and transcription still works.

## Files

- `index.html` – UI
- `js/app.js` – recording, upload, audio decoding (16 kHz mono), worker messaging, form template/filling UI, IndexedDB wiring
- `js/worker.js` – Web Worker running the Whisper pipeline (Transformers.js 3.8.1 from jsdelivr CDN)
- `js/llm-worker.js` – Web Worker running the form-filling LLM (Web-LLM 0.2.84 from esm.run CDN)
- `js/db.js` – IndexedDB wrapper (transcripts, recordings, form template)

## Notes

- First load requires internet access (model + library download). For a fully air-gapped deployment, vendor the Transformers.js library and the model files locally and point the worker at them.
- The legacy FastAPI/Python backend was removed; old server-side data remains untouched in `data/`.

## Full documentation

Obsidian: `AI_projects/projects/whisper.md` in vault `Gennady/AI_projects`.
