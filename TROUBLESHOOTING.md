# Troubleshooting

## Microphone button does nothing / permission error

Browsers only allow microphone access on a **secure context**: `http://localhost` or HTTPS. If you open `index.html` directly from disk (`file://`) or over plain HTTP on another host, recording will not work. Serve the folder (`python -m http.server`) and open it via `http://localhost:8000`.

## Engine badge shows "WASM (CPU)" and transcription is slow

WebGPU is not available in your browser or for your GPU. Use a recent Chrome or Edge. WASM still works, just slower — prefer the `base` model there.

## Model download is slow or fails

The model (~80–250 MB) is fetched from `huggingface.co` on first use. Check that the network allows access to `huggingface.co` and `cdn.jsdelivr.net`. After a successful download, the model is cached by the browser and works offline.

## Transcripts disappeared

Transcripts are stored in the browser's IndexedDB, scoped to the exact origin (protocol + host + port). Opening the app on a different port or browser profile shows a different (empty) history. Clearing site data also deletes them — download important transcripts as `.txt`.

## "Could not decode this audio file"

The browser could not decode the uploaded format. Convert to WAV/MP3/M4A/OGG/WebM first (e.g. with ffmpeg: `ffmpeg -i input.xyz output.mp3`).

## "Fill form" button is disabled

Form filling runs a local LLM that **requires WebGPU** (there is no CPU fallback, unlike transcription). Use a recent Chrome or Edge on a machine with a GPU. Transcription keeps working without it.

## Form model download fails or is slow

The form model (~900 MB) is fetched from `huggingface.co` (via the Web-LLM library on `esm.run`/`jsdelivr`) on first use, then cached. If the download is interrupted, click "Fill form" again — it resumes from the cache. Check that the network allows those hosts.

## Form filling fails with a memory/device error

The LLM needs roughly 2 GB of GPU memory. Close other GPU-heavy tabs and applications and try again. On machines with very little GPU memory the model may not fit at all.

## Form fields come back empty or wrong

The model only extracts what is literally in the transcript (temperature 0, schema-constrained). Improve the per-field hints in the template (e.g. "Prescriptions with dosage"), or edit the filled fields manually — they are plain text boxes. Very long transcripts are truncated to roughly the first 16,000 characters for extraction.
