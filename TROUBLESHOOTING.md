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
