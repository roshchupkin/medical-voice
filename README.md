# Whisper – fully in-browser medical voice-to-text

A static web app that records or uploads audio and transcribes it with Whisper **entirely inside the browser**. There is no backend: the model runs locally via [Transformers.js](https://github.com/huggingface/transformers.js) on WebGPU (with WebAssembly fallback), and all transcripts and recordings are stored in the browser's IndexedDB. No audio or text ever leaves the machine.

A second local model ([Web-LLM](https://github.com/mlc-ai/web-llm) running Qwen2.5 1.5B Instruct over WebGPU) powers a **clinician-in-the-loop** workflow for Dutch medical documentation — also fully in-browser. The app deliberately does **not** fill a form directly from the raw Whisper transcript. Instead it improves the transcript, flags uncertain passages, lets the clinician review and correct them, and only then fills a structured form with full source traceability.

## Safe workflow

```
audio
  → Whisper transcription (raw, kept unchanged + segment timestamps)
  → local correction rules + LLM correction with uncertainty annotation
  → clinician review/correction (green/yellow/red, red must be reviewed)
  → final reviewed transcript (+ edit log)
  → LLM form-fill from the reviewed transcript only (with source traceability)
  → clinician reviews each field's source chain and approves
```

Design principle: the LLM may fix spelling, grammar, and clear recognition errors, but must **never silently change clinical meaning** (medication, dosage, left/right, negations, numbers, dates, diagnoses, allergies). When unsure it flags the passage instead of guessing, and the clinician always stays in control.

## Quick start

Serve the folder with any static file server, e.g.:

```powershell
python -m http.server 8000
# or
npx serve .
```

Then open http://localhost:8000. The microphone only works on `localhost` or HTTPS.

## How it works

- **Models**: Whisper large-v3-turbo (default), Whisper medium (lighter), or Whisper large-v3 (best accuracy) — selectable in the UI and configurable in `js/config.js`. Downloaded from Hugging Face on first transcription (4-bit weights), then cached by the browser — subsequent use works fully offline.
- **Engine**: WebGPU when the browser/GPU supports it (Chrome/Edge), otherwise WebAssembly on the CPU (slower).
- **Languages**: Dutch (default) or English from the dropdown.
- **Storage**: transcripts and their audio live in IndexedDB on this device only, encrypted per user. **Recordings are persisted incrementally** (every 5 s) while you record; **transcription drafts autosave** per segment for live recordings. After unlock or a crash, use the recovery banner to restore audio or resume transcription. Click **Save transcript** to finalize a draft.

### Step 1 — Whisper transcription

Whisper produces the raw transcript with segment-level timestamps. The raw transcript is **kept unchanged** and stored separately from every later version. Because the high-level Transformers.js pipeline does not expose true token log-probabilities, per-segment **ASR confidence is approximated heuristically** from the timestamps (speaking rate, zero-duration segments, repeated-token hallucination patterns). This is one of three uncertainty signals — never the sole gate.

### Step 2 — Improve & review

Clicking **"Improve & review"** runs, all locally:

1. **Local correction rules** (`replace` / `expand` / `protect`) defined by the clinician are applied first; `protect` terms are passed to the LLM as "do not change".
2. The **correction LLM** (`Qwen2.5-1.5B-Instruct`, 4-bit, ~900 MB, shared with the form-filler — one model load) improves the transcript using the Dutch medical core rule and returns structured JSON per segment (change type, confidence, clinical risk, reason, global warnings). Robust JSON parsing falls back to "no change, flag for review".
3. **Uncertainty scoring** merges ASR confidence + LLM semantic uncertainty + a clinical-importance lexicon into **green / yellow / red** per segment, with hard safety overrides (e.g. any unclear negation, laterality, dosage, or number is red).

The review UI shows a green/yellow/red highlighted transcript with a summary banner, a raw↔corrected toggle, and a per-segment panel to compare raw vs corrected, edit, accept/reject/confirm, and add notes. **Form generation is gated until every red passage is reviewed.** A "Correctieregel toevoegen" box lets the clinician add local correction rules on the fly.

### Step 3 — Medical form with source traceability

Once the review is complete, **"Genereer formulier"** builds the final reviewed transcript (plus an edit log distinguishing rule/LLM/clinician changes) and feeds **only that** to the form-filling LLM. Output is structured JSON: each field carries its `source_sentence`, `source_segment_id`, confidence, `was_inferred`, `needs_review`, and an optional warning, plus `missing_fields` and `overall_warnings`. Missing information becomes `"niet vermeld"` rather than being invented.

Each field is editable and has a **"Toon bron"** (show source) panel revealing the full chain: raw Whisper sentence → LLM correction → final reviewed text, whether it was edited, its prior green/yellow/red flag, and whether the value was stated or inferred. The clinician **approves** the form (records a timestamp) and can export the full provenance as `.json`. Requires WebGPU — without it the review/form steps are disabled and transcription still works.

All versions (raw, LLM-corrected, final reviewed) and the edit log are stored encrypted with the transcript.

## Login and encryption

The app is multi-user without any server. Each clinician logs in with a username + password; from these the browser derives (PBKDF2, 600k iterations, then HKDF):

- an **anonymous auth token**, checked against the list in `js/config.js` — that file contains no usernames or password hashes, only opaque tokens, and is safe to expose;
- an **AES-GCM key**, kept in memory only, which encrypts all transcripts, recordings, and form data in IndexedDB. Without logging in, the database contains only ciphertext. Each user sees only their own data.

Managing accounts: serve the app locally, open `tools/generate-token.html`, enter the clinician's username and password, and paste the generated token into `APPROVED_ACCESS_TOKENS` in `js/config.js`. To revoke access, remove the token. Do not deploy the `tools/` folder to shared workstations.

A default demo account ships in `config.js` (username `demo`, password `whisper-demo`) — **replace it before real use**.

The app auto-locks after 5 minutes of inactivity (configurable in `js/config.js`); active recording or transcription does not count as inactivity. A forgotten password means that user's data is unrecoverable — there is no backdoor. Note: this protects confidentiality of stored data; it does not stop someone with machine access from deleting the database or tampering with the served files.

## Files

- `index.html` – UI: login overlay, transcribe panel, saved transcripts, Step 2 review panel, Step 3 form panel
- `js/app.js` – recording, upload, audio decoding (16 kHz mono), worker messaging, the staged pipeline orchestration, template/form UI wiring, IndexedDB wiring, login/lock UI flow
- `js/worker.js` – Web Worker running the Whisper pipeline with segment timestamps (Transformers.js 3.8.1 from jsdelivr CDN)
- `js/llm-worker.js` – Web Worker running the shared local LLM (Web-LLM 0.2.84 from esm.run CDN) with two tasks: `correct` (transcript correction) and `extract` (traceable form-fill)
- `js/segments.js` – sentence segmentation + heuristic ASR-confidence scoring from Whisper timing
- `js/clinical-lexicon.js` – seed Dutch clinical lexicon + clinical-importance scoring and medical-term detection
- `js/correction-memory.js` – local correction memory (rules: replace/expand/protect; session + persistent scopes)
- `js/uncertainty.js` – merges ASR + LLM + clinical importance into green/yellow/red annotations
- `js/final-transcript.js` – builds the final reviewed transcript, edit log, and segment source chains
- `js/review-ui.js` – clinician transcript review UI (highlights, per-segment editing, red gating)
- `js/form-review-ui.js` – traceable form review UI (per-field source chain, approval, provenance export)
- `js/safety.js` – centralized safety rules and gates ("niet vermeld", red gating, raw preservation)
- `js/db.js` – IndexedDB wrapper (transcripts, recordings, form template, correction rules, dictionaries), encrypted at rest per user
- `js/auth.js` – PBKDF2/HKDF key derivation, session state, inactivity auto-lock
- `js/crypto-store.js` – AES-GCM encrypt/decrypt helpers
- `js/config.js` – approved access tokens + security tuning (safe to expose)
- `tools/generate-token.html` – admin-only token generator (do not deploy)

## Notes

- First load requires internet access (model + library download). For a fully air-gapped deployment, vendor the Transformers.js library and the model files locally and point the worker at them.
- The legacy FastAPI/Python backend was removed; old server-side data remains untouched in `data/`.

## Full documentation

Obsidian: `AI_projects/projects/whisper.md` in vault `Gennady/AI_projects`.
