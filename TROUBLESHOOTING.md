# Troubleshooting

## Microphone button does nothing / permission error

Browsers only allow microphone access on a **secure context**: `http://localhost` or HTTPS. If you open `index.html` directly from disk (`file://`) or over plain HTTP on another host, recording will not work. Serve the folder (`python -m http.server`) and open it via `http://localhost:8000`.

## Engine badge shows "WASM (CPU)" and transcription is slow

WebGPU is not available in your browser or for your GPU. Use a recent Chrome or Edge. WASM still works, just slower — prefer the lighter "Whisper medium" model there.

## Model download is slow or fails

The Whisper model is fetched from `huggingface.co` on first use (4-bit weights; size depends on the selected model). Check that the network allows access to `huggingface.co` and `cdn.jsdelivr.net`. After a successful download, the model is cached by the browser and works offline.

## Transcripts disappeared

Transcripts are stored in the browser's IndexedDB, scoped to the exact origin (protocol + host + port). Opening the app on a different port or browser profile shows a different (empty) history. Clearing site data also deletes them — download important transcripts as `.txt`.

## "Could not decode this audio file"

The browser could not decode the uploaded format. Convert to WAV/MP3/M4A/OGG/WebM first (e.g. with ffmpeg: `ffmpeg -i input.xyz output.mp3`).

## "Improve & review" button is disabled / "No WebGPU adapter found"

Transcript correction and form filling need a **working WebGPU GPU adapter**, not just the WebGPU API. The app checks this at startup; if the button stays disabled or you see *No WebGPU adapter found*, try in order:

1. **Fully restart the browser** (close all windows, not just the tab). A prior GPU crash (`DXGI_ERROR_DEVICE_HUNG` / "Device was lost") often leaves WebGPU without an adapter until restart.
2. Use **Chrome or Edge** on the local machine (not Remote Desktop / some virtual desktops).
3. Open `chrome://gpu` — WebGPU should show *Hardware accelerated*. If not, update graphics drivers and check `chrome://flags` that WebGPU is enabled.
4. Close other GPU-heavy tabs and applications, then reload the page.

Transcription (Whisper) still works without WebGPU — it falls back to WASM on the CPU.

## Local assistant download fails or is slow

The shared local model (`Qwen2.5-1.5B-Instruct`, ~900 MB) is fetched from `huggingface.co` (via the Web-LLM library on `esm.run`/`jsdelivr`) on first use, then cached. It is loaded **once** and used for both the correction and form-filling steps. If the download is interrupted, click "Improve & review" again — it resumes from the cache. Check that the network allows those hosts.

## Correction or form filling fails with a memory/device error

The LLM needs roughly 2 GB of GPU memory. Close other GPU-heavy tabs and applications and try again. On machines with very little GPU memory the model may not fit at all.

## "Genereer formulier" won't proceed

Form generation is intentionally **gated**: every red (high-risk) passage in the transcript review must be reviewed first (confirm, edit, or reject it in the per-segment panel). The banner shows how many red passages remain. This prevents filling a form from a transcript with unresolved high-risk uncertainty.

## The transcript correction didn't change much / flagged a lot

The correction model is a small 1.5B local model: the value is the **safety scaffolding** (flagging uncertainty, gating, traceability), not perfect autocorrection. When unsure it deliberately flags rather than guesses, and it never silently changes medication, dosage, left/right, or negations. Use local correction rules ("Correctieregel toevoegen") to teach it clear, repeatable fixes (e.g. `metformien` → `metformine`) or to protect terms that must not change.

## Form fields come back empty or wrong

The model only extracts what is literally in the **reviewed** transcript (temperature 0); missing information becomes `"niet vermeld"` rather than being invented. Use each field's "Toon bron" panel to trace where a value came from, improve the per-field hints in the template, or edit the field manually. Very long transcripts are truncated to roughly the first 16,000 characters for extraction.
