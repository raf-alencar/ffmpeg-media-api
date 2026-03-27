# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-03-24

Initial public release.

### Audio

- `POST /audio/normalize` — EBU R128 loudnorm with configurable target LUFS, true peak, and LRA
- `POST /audio/concat` — join multiple audio files in sequence
- `POST /audio/assemble` — podcast assembly with per-clip silence gaps, optional normalize pass, optional background music
- `POST /audio/mix-music` — layer background music under speech with volume control and loop support. Strips embedded album art from music inputs automatically.
- `POST /audio/trim` — trim audio to start/end points
- `POST /audio/fade` — fade in, out, or both with auto-calculated fade-out start point
- `POST /audio/probe` — ffprobe metadata

### Video

- `POST /video/concat` — join video clips in sequence
- `POST /video/add-audio` — attach or mix audio onto a video
- `POST /video/transition` — crossfade between two video clips using xfade filter
- `POST /video/trim` — trim video to start/end points
- `POST /video/fade` — fade to/from black or white, video and audio simultaneously
- `POST /video/overlay` — composite a transparent PNG over a video with position, scale, and opacity control
- `POST /video/mix-music` — layer background music under video audio
- `POST /video/assemble` — full visual sequencer: images and videos, per-clip Ken Burns, per-clip transitions, chained xfade filter graph, silent output
- `POST /video/mix` — add voiceover and/or background music to a video, all combinations supported
- `POST /video/probe` — ffprobe metadata

### Image

- `POST /image/to-video` — convert still image to video clip with duration control
- `POST /image/zoom` — Ken Burns zoom/pan effect with six direction options and configurable speed. Auto-detects portrait vs landscape orientation.

### Render

- `POST /render/episode` — full pipeline: clips + audio → assembled video
- `POST /render/probe` — ffprobe any file type

### Utility (gnh1201/ffmpeg-api compatibility)

- `POST /convert/audio/to/mp3`
- `POST /convert/audio/to/wav`
- `POST /convert/video/to/mp4`
- `POST /convert/image/to/jpg`
- `POST /video/extract/audio`
- `POST /video/extract/images`
- `POST /probe`

### Architecture

- All endpoints accept JSON body with `*_url` fields — no binary upload required
- Multipart file upload supported as fallback on all endpoints
- All temporary files cleaned up after each request
- ffmpeg errors returned as structured JSON with stderr details
