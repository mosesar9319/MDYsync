# Production Architecture

## 1. Ingestion

- Upload video directly to object storage with a signed multipart upload.
- Extract audio with FFmpeg in a worker.
- Split long audio into overlapping chunks.
- Store the source video, audio chunks, processing status, transcript, and alignment separately.

Do not send full lecture videos through a normal Netlify Function request. Function request limits are too small for typical shiur files.

## 2. Transcription

Use a multilingual speech-to-text model with prompts containing:

- Masechta and daf
- Common Aramaic vocabulary
- Names of Tannaim and Amoraim
- Expected Hebrew/English code-switching

Persist timestamped transcript segments and, when available, word timestamps.

## 3. Text retrieval

Retrieve canonical source and translation through Sefaria's v3 Texts API. Preserve Sefaria segment references as stable identifiers.

## 4. Semantic alignment

Use a monotonic alignment pipeline:

1. Normalize Hebrew/Aramaic orthography and remove cantillation/diacritics.
2. Detect direct quotations through token overlap and fuzzy matching.
3. Detect Sefaria references and quoted commentaries.
4. Ask a language model to rank the most likely current source segment using the local transcript window and nearby daf segments.
5. Apply sequence constraints so the location usually moves forward, while allowing repeats and explicit jumps.
6. Assign confidence scores and send low-confidence intervals to the editor.

## 5. Editor

The editor should allow:

- Dragging boundaries on a waveform/timeline
- Selecting words or phrases on the daf
- Marking excursions to Rashi, Tosafos, Tanakh, or another daf
- Reviewing only low-confidence segments
- Version history and approval status

## 6. Playback delivery

- Stream HLS or DASH video from a CDN.
- Fetch the compact alignment JSON when the player opens.
- Use binary search to resolve the active segment on every seek/time update.
- Pre-compute traditional-page word coordinates for Vilna-page mode.

## 7. Vilna page support

For each scanned page:

- Deskew and segment the printed columns
- OCR every word into bounding boxes
- Match OCR tokens to the canonical text
- Store `{ref, wordIndex, x, y, width, height}`
- Draw highlights in an SVG/canvas overlay

This page-coordinate layer can use the exact same time alignment JSON as the digital text view.


## Linked video sources

The browser player uses a common playback adapter so local HTML5 media, direct media URLs, and YouTube IFrame Player videos expose the same operations: current time, duration, play/pause, seeking, and playback rate. The alignment timeline remains independent from the video host. YouTube videos must allow embedding, and automated server-side transcription of a third-party YouTube video should only be performed when the product has the necessary authorization and a compliant media-ingestion route.

## 8. Pilot alignment workflow

The Chullin 81 pilot uses a review-first workflow:

1. Load the canonical daf and embedded lecture.
2. Generate placeholder spacing only to make every segment addressable.
3. Mark actual segment starts while listening with the rapid marker control.
4. Persist progress in browser local storage and export a portable alignment JSON.
5. Review repeats, digressions, Rashi/Tosafos sections, and the 81a/81b transition.
6. Change the project status from `placeholder` to `in-progress`, then `complete` only after review.

This prevents automatically generated or evenly spaced timestamps from being mistaken for verified alignment.

## 9. YouTube transcription constraint

The embedded YouTube player supplies playback controls and timing, but does not expose a public video's caption track through the IFrame Player API. Production ingestion should therefore use one of these compliant paths:

- A video or audio file uploaded by the content owner
- Captions supplied by the content owner
- An authorized YouTube Data API workflow for a channel the user controls
- A separately licensed media-processing route

The alignment engine should never claim a transcript or timestamp map was generated when the source audio was unavailable.
