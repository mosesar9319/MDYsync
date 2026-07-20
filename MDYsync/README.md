# DafSync Studio — Chullin 81 Pilot

A browser-based prototype for synchronizing a Daf Yomi lecture video with the exact portion of Gemara currently being discussed.

## Included in this build

- Local video selection (the lecture is not uploaded)
- YouTube URL playback through the YouTube IFrame Player API
- Direct browser-playable MP4/WebM/audio URLs
- Built-in 48-second demo video
- Timestamp-linked Hebrew daf segments
- Live highlighting during playback
- Immediate highlighting while scrubbing
- Hover preview showing the phrase at any timeline position
- Click a phrase to seek the lecture
- 10-second forward/back controls and playback speed
- Sefaria reference loader through a Netlify Function
- Alignment editor with manual timestamp correction
- Import/export of reusable synchronization JSON, including the reusable video source
- Import of timestamped transcript JSON with basic Hebrew phrase matching
- Responsive desktop/mobile design
- Preconfigured real-world pilot for Chullin 81 using YouTube video `JjEa3Jd6XPU`
- Rapid “mark here and advance” workflow with the `M` keyboard shortcut
- Browser-local draft saving and automatic pilot-draft restoration
- Alignment status tracking: needs alignment, in progress, and aligned draft


## Chullin 81 pilot

1. Deploy or serve the project over HTTP.
2. Press **Load Chullin 81 pilot**.
3. The app connects to `https://www.youtube.com/watch?v=JjEa3Jd6XPU` and retrieves **Chullin 81** from Sefaria.
4. Start playback and select the first Gemara segment being discussed.
5. At the moment the rabbi begins that segment, press **M** or **Mark here & advance**.
6. Continue through the shiur. Each mark sets the current segment's start, closes the previous segment, and advances the marking cursor.
7. Use **Save draft** at any time. Drafts remain in that browser's local storage.
8. Use **Export** to create the portable synchronization JSON.

The initial even spacing is only a placeholder. It is deliberately labeled **Needs alignment** until actual timestamps are marked. The build does not claim that unreviewed timestamps match the shiur.

## Run locally

Because browser modules and video files work best through HTTP, run a small local server:

```bash
cd daf-sync-prototype
python3 -m http.server 8080
```

Open `http://localhost:8080`.

The built-in Sefaria proxy only runs under Netlify. When running locally, the app attempts the public Sefaria API directly.

## Deploy to Netlify

The project is a static site and already contains `netlify.toml`.

```bash
npx netlify deploy --dir .
```

For production:

```bash
npx netlify deploy --dir . --prod
```

## Video sources

The **Video link** tab accepts:

- Standard YouTube URLs (`youtube.com/watch?v=...`)
- Short YouTube URLs (`youtu.be/...`)
- YouTube Shorts, Live, and embed URLs
- Direct media file URLs that the browser can play, such as MP4 or WebM

A normal webpage URL from another video platform is not necessarily a playable media URL. YouTube videos must permit embedding. Private videos and videos whose owners disabled embedding cannot be loaded. Live streams do not provide a stable final duration and are not recommended for permanent alignment until the recording becomes video-on-demand.

## Alignment JSON

```json
{
  "schema": "dafsync-alignment-v2",
  "title": "Lecture title",
  "dafRef": "Berakhot 2a",
  "duration": 3600,
  "projectId": "chullin-81-jjea3jd6xpu",
  "alignmentStatus": "in-progress",
  "videoSource": {
    "type": "youtube",
    "videoId": "abcdefghijk",
    "url": "https://www.youtube.com/watch?v=abcdefghijk"
  },
  "segments": [
    {
      "ref": "Berakhot 2a.1",
      "start": 0,
      "end": 35.2,
      "he": "מאימתי קורין את שמע בערבין",
      "en": "From when may one recite the Shema in the evening?"
    }
  ]
}
```

## Transcript JSON

The transcript importer accepts either an array or an object with a `segments` array:

```json
{
  "segments": [
    { "start": 0, "end": 6.2, "text": "מאימתי קורין את שמע בערבין..." }
  ]
}
```

The current browser matcher is intentionally simple. The production semantic alignment service should handle English explanation, paraphrase, Rashi/Tosafos citations, repeats, and jumps to other sources.
