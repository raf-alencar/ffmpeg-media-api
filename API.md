# ffmpeg-media-api Documentation

**Version:** 1.0.0  
**Base URL:** `http://localhost:3223`  
**Health check:** `GET /` — returns status, version, and full endpoint listing

---

## Overview

A self-hosted HTTP API for audio and video production via ffmpeg. All endpoints return binary file output (audio or video) directly in the response body.

### Input model

All endpoints accept input in two forms — use whichever fits your workflow:

**JSON body with URL fields (preferred for n8n and automated pipelines):**
```json
{ "audio_url": "https://your-host.com/file.mp3" }
```

**Multipart file upload (fallback for direct binary sending):**
```
field name: audio | video | image | file
```

### Output model

All endpoints return the processed file as a binary download with appropriate `Content-Type` and `Content-Disposition` headers. On error, a JSON body is returned:
```json
{ "error": "context description", "details": "ffmpeg stderr output" }
```

---

## Audio Endpoints

---

### `POST /audio/normalize`

Normalize audio loudness to EBU R128 broadcast standard.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audio_url` | string | — | URL of the audio file |
| `target_lufs` | number | `-16` | Target integrated loudness in LUFS |
| `true_peak` | number | `-1.5` | Maximum true peak level in dBTP |
| `lra` | number | `11` | Loudness range target |
| `ar` | number | `44100` | Output sample rate in Hz |

**Returns:** normalized `.mp3`

**Example:**
```bash
curl -X POST http://localhost:3223/audio/normalize \
  -H "Content-Type: application/json" \
  -d '{"audio_url": "https://your-host.com/speech.mp3"}' \
  -o normalized.mp3
```

---

### `POST /audio/concat`

Join multiple audio files in sequence with no gaps.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `urls` | string[] | — | Ordered array of audio URLs. Files are sorted by filename before joining. |
| `ar` | number | `44100` | Output sample rate |

**Returns:** merged `.mp3`

**Example:**
```bash
curl -X POST http://localhost:3223/audio/concat \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://your-host.com/01.mp3", "https://your-host.com/02.mp3"]}' \
  -o concat.mp3
```

---

### `POST /audio/assemble`

Podcast assembly endpoint. Takes an ordered list of audio clips with per-clip silence gaps, stitches them into a single episode file. The primary output endpoint for podcast production.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `clips` | object[] | — | Ordered array of clip objects (see below) |
| `normalize` | bool | `true` | Run EBU R128 loudnorm pass on the assembled output |
| `music_url` | string | — | Optional background music URL |
| `music_volume` | number | `0.08` | Background music volume (0.0–1.0) |
| `loop_music` | bool | `true` | Loop music if shorter than speech |
| `ar` | number | `44100` | Output sample rate |

**Clip object:**

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Audio file URL |
| `pause_after_ms` | number | Silence to insert after this clip in milliseconds |

**Pause timing reference:**

| Value | Usage |
|-------|-------|
| `600ms` | Normal back-and-forth turn gap |
| `900ms` | After longer speech block or rhetorical beat |
| `1500ms` | Section conclusion or major idea shift |
| `2000ms` | Stage direction / music cue gaps |

**Returns:** assembled `.mp3`

**Example:**
```bash
curl -X POST http://localhost:3223/audio/assemble \
  -H "Content-Type: application/json" \
  -d '{
    "clips": [
      {"url": "https://your-host.com/01.mp3", "pause_after_ms": 600},
      {"url": "https://your-host.com/02.mp3", "pause_after_ms": 900},
      {"url": "https://your-host.com/03.mp3", "pause_after_ms": 0}
    ],
    "normalize": true
  }' \
  -o episode.mp3
```

---

### `POST /audio/mix-music`

Layer background music under a speech track. Music is automatically looped if shorter than the speech and trimmed to match speech duration.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `speech_url` | string | — | Primary speech/voiceover audio URL |
| `music_url` | string | — | Background music URL |
| `music_volume` | number | `0.08` | Music volume (0.0–1.0). Typical range: 0.05–0.10 |
| `loop_music` | bool | `true` | Loop music to match speech length |
| `ar` | number | `44100` | Output sample rate |

**Note:** Embedded album art / video streams in music MP3s are automatically stripped before mixing.

**Returns:** mixed `.mp3`

**Example:**
```bash
curl -X POST http://localhost:3223/audio/mix-music \
  -H "Content-Type: application/json" \
  -d '{
    "speech_url": "https://your-host.com/episode.mp3",
    "music_url": "https://your-host.com/background.mp3",
    "music_volume": 0.08,
    "loop_music": true
  }' \
  -o mixed.mp3
```

---

### `POST /audio/trim`

Trim an audio file to a start and/or end point.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audio_url` | string | — | Audio file URL |
| `start_s` | number | `0` | Start point in seconds |
| `end_s` | number | — | End point in seconds. Omit to trim from start_s to end of file. |

**Returns:** trimmed `.mp3`

**Example:**
```bash
curl -X POST http://localhost:3223/audio/trim \
  -H "Content-Type: application/json" \
  -d '{"audio_url": "https://your-host.com/audio.mp3", "start_s": 5, "end_s": 30}' \
  -o trimmed.mp3
```

---

### `POST /audio/fade`

Apply fade in, fade out, or both to an audio file. Fade-out start point is calculated automatically from file duration.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audio_url` | string | — | Audio file URL |
| `fade_type` | string | `"out"` | `"in"` \| `"out"` \| `"both"` |
| `fade_duration_s` | number | `1.0` | Duration of each fade in seconds |

**Returns:** faded `.mp3`

**Example:**
```bash
curl -X POST http://localhost:3223/audio/fade \
  -H "Content-Type: application/json" \
  -d '{"audio_url": "https://your-host.com/audio.mp3", "fade_type": "both", "fade_duration_s": 1.5}' \
  -o faded.mp3
```

---

### `POST /audio/probe`

Return ffprobe metadata for an audio file.

**Body parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `audio_url` | string | Audio file URL |

**Returns:** JSON ffprobe output (streams + format)

---

## Video Endpoints

---

### `POST /video/concat`

Join multiple video clips in sequence. Files are sorted by filename before joining.

**Body parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `urls` | string[] | Ordered array of video URLs |

**Returns:** concatenated `.mp4`

---

### `POST /video/add-audio`

Attach an audio track to a video file.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `video_url` | string | — | Video file URL |
| `audio_url` | string | — | Audio file URL |
| `replace_audio` | bool | `true` | `true` replaces existing audio. `false` mixes with existing audio. |

**Returns:** `.mp4` with audio attached

---

### `POST /video/transition`

Concatenate two video clips with a crossfade transition between them.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `urls` | string[] | — | Array of exactly 2 video URLs |
| `transition_type` | string | `"fade"` | `"fade"` \| `"cut"` |
| `transition_duration_s` | number | `0.5` | Crossfade duration in seconds |

**transition_duration_s reference:**

| Value | Feel |
|-------|------|
| `0.3` | Quick, snappy |
| `0.5` | Standard |
| `1.0` | Slow, cinematic |
| `2.0` | Very slow dissolve |

**Note:** Crossfade is fully implemented for exactly 2 clips. 3+ clips falls back to a hard cut.

**Returns:** `.mp4` with transition applied

---

### `POST /video/trim`

Trim a video to a start and/or end point.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `video_url` | string | — | Video file URL |
| `start_s` | number | `0` | Start point in seconds |
| `end_s` | number | — | End point in seconds. Omit to trim from start_s to end of file. |

**Returns:** trimmed `.mp4`

---

### `POST /video/fade`

Fade a video to/from black or white. Both video and audio tracks are faded simultaneously.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `video_url` | string | — | Video file URL |
| `fade_type` | string | `"out"` | `"in"` \| `"out"` \| `"both"` |
| `fade_duration_s` | number | `1.0` | Duration of each fade in seconds |
| `fade_color` | string | `"black"` | `"black"` \| `"white"` |

**Returns:** faded `.mp4`

**Example:**
```bash
curl -X POST http://localhost:3223/video/fade \
  -H "Content-Type: application/json" \
  -d '{
    "video_url": "https://your-host.com/clip.mp4",
    "fade_type": "both",
    "fade_duration_s": 1.0,
    "fade_color": "black"
  }' \
  -o faded.mp4
```

---

### `POST /video/overlay`

Composite a static transparent PNG over a video for its full duration. PNG alpha channel is respected natively. Primary use case: text overlays, graphic frames, logo bugs, Vogue-style cover treatments.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `video_url` | string | — | Video file URL |
| `overlay_url` | string | — | PNG with transparency URL |
| `position` | string | `"center"` | Named position (see table below) |
| `x` | number | — | Custom X offset in pixels. Overrides `position` if set alongside `y`. |
| `y` | number | — | Custom Y offset in pixels. Overrides `position` if set alongside `x`. |
| `scale_to_fit` | bool | `false` | Scale PNG to match video dimensions exactly. Use `true` for full-frame overlays. |
| `opacity` | number | `1.0` | Overlay opacity 0.0–1.0 |

**Position options:**

| Value | Placement |
|-------|-----------|
| `center` | Centered horizontally and vertically (default) |
| `top-left` | Top left corner |
| `top-right` | Top right corner |
| `top-center` | Centered horizontally, top edge |
| `bottom-left` | Bottom left corner |
| `bottom-right` | Bottom right corner |
| `bottom-center` | Centered horizontally, bottom edge |

**Note:** Existing audio on the video is preserved automatically.

**Returns:** `.mp4` with overlay composited

**Example — full-frame cover overlay:**
```bash
curl -X POST http://localhost:3223/video/overlay \
  -H "Content-Type: application/json" \
  -d '{
    "video_url": "https://your-host.com/background.mp4",
    "overlay_url": "https://your-host.com/cover-frame.png",
    "position": "center",
    "scale_to_fit": true,
    "opacity": 1.0
  }' \
  -o cover.mp4
```

**Example — bottom-right logo bug at 80% opacity:**
```bash
curl -X POST http://localhost:3223/video/overlay \
  -H "Content-Type: application/json" \
  -d '{
    "video_url": "https://your-host.com/episode.mp4",
    "overlay_url": "https://your-host.com/logo.png",
    "position": "bottom-right",
    "scale_to_fit": false,
    "opacity": 0.8
  }' \
  -o branded.mp4
```

---

### `POST /video/mix-music`

Layer background music under a video's existing audio track.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `video_url` | string | — | Video file URL |
| `music_url` | string | — | Background music URL |
| `music_volume` | number | `0.08` | Music volume (0.0–1.0) |
| `loop_music` | bool | `true` | Loop music to match video length |

**Returns:** `.mp4` with music mixed in

---

### `POST /video/probe`

Return ffprobe metadata for a video file.

**Body parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `video_url` | string | Video file URL |

**Returns:** JSON ffprobe output (streams + format)

---

### `POST /video/assemble`

Pure visual sequencer. Takes an ordered list of image and video clips, applies per-clip Ken Burns effects and per-clip transitions, outputs a **silent** MP4. Designed for iteration — run this as many times as needed before adding audio with `/video/mix`.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `clips` | object[] | — | Ordered array of clip objects (see below) |
| `width` | number | `1920` | Output width in pixels |
| `height` | number | `1080` | Output height in pixels |
| `fps` | number | `25` | Output frame rate |

**Clip object — image:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | — | Image URL |
| `type` | string | — | Must be `"image"` |
| `duration_s` | number | `5` | How long the image appears in seconds |
| `zoom_direction` | string | — | Ken Burns direction. Omit for static. |
| `zoom_from` | number | `1.0` | Starting zoom multiplier |
| `zoom_to` | number | `1.05` | Ending zoom multiplier |
| `transition_out` | object | `{type:"fade", duration_s:0.5}` | Transition to next clip |

**Clip object — video:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | — | Video URL |
| `type` | string | — | Must be `"video"` |
| `keep_audio` | bool | `false` | Keep existing audio track. Default strips audio — output is always silent. |
| `trim_start_s` | number | — | Trim start point in seconds |
| `trim_end_s` | number | — | Trim end point in seconds |
| `duration_s` | number | — | Limit clip duration (applied if no trim_start_s set) |
| `transition_out` | object | `{type:"fade", duration_s:0.5}` | Transition to next clip |

**transition_out object:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | `"fade"` | `"fade"` \| `"cut"` |
| `duration_s` | number | `0.5` | Crossfade duration in seconds |

**zoom_direction options:**

| Value | Movement |
|-------|----------|
| `in` | Slow zoom toward center |
| `out` | Slow zoom away from center |
| `left` | Pan left at fixed zoom |
| `right` | Pan right at fixed zoom |
| `in-left` | Zoom in while panning left |
| `in-right` | Zoom in while panning right |

**zoom_from / zoom_to speed reference:**

| zoom_from | zoom_to | Feel |
|-----------|---------|------|
| `1.0` | `1.02` | Very subtle |
| `1.0` | `1.05` | Gentle (default) |
| `1.0` | `1.08` | Noticeable |
| `1.0` | `1.15` | Dramatic |

**Returns:** silent `.mp4`

**Example:**
```bash
curl -X POST http://localhost:3223/video/assemble \
  -H "Content-Type: application/json" \
  -d '{
    "clips": [
      {
        "url": "https://your-host.com/cover.jpg",
        "type": "image",
        "duration_s": 5,
        "zoom_direction": "in",
        "zoom_from": 1.0,
        "zoom_to": 1.05,
        "transition_out": {"type": "fade", "duration_s": 0.5}
      },
      {
        "url": "https://your-host.com/clip.mp4",
        "type": "video",
        "keep_audio": false,
        "trim_start_s": 0,
        "trim_end_s": 10,
        "transition_out": {"type": "cut"}
      },
      {
        "url": "https://your-host.com/end-card.png",
        "type": "image",
        "duration_s": 3,
        "zoom_direction": "out"
      }
    ],
    "width": 1920,
    "height": 1080,
    "fps": 25
  }' \
  -o assembled.mp4
```

---

### `POST /video/mix`

Add voiceover and/or background music to a video. All audio inputs are optional — supply any combination. The recommended downstream step after `/video/assemble`.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `video_url` | string | — | Video file URL (required) |
| `voiceover_url` | string | — | Voiceover audio URL |
| `voiceover_volume` | number | `1.0` | Voiceover volume (0.0–1.0) |
| `music_url` | string | — | Background music URL |
| `music_volume` | number | `0.08` | Music volume (0.0–1.0) |
| `loop_music` | bool | `true` | Loop music to match video length |
| `replace_original` | bool | `true` | Strip existing video audio before mixing. Set `false` to mix over it. |

**At least one of `voiceover_url` or `music_url` is required.**

**Returns:** `.mp4` with audio mixed in

**Example — voiceover + music:**
```bash
curl -X POST http://localhost:3223/video/mix \
  -H "Content-Type: application/json" \
  -d '{
    "video_url": "https://your-host.com/assembled.mp4",
    "voiceover_url": "https://your-host.com/episode.mp3",
    "voiceover_volume": 1.0,
    "music_url": "https://your-host.com/background.mp3",
    "music_volume": 0.08,
    "loop_music": true,
    "replace_original": true
  }' \
  -o final.mp4
```

---

## Image Endpoints

---

### `POST /image/to-video`

Convert a still image to a video clip of a fixed duration. Output is a static (no motion) video.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_url` | string | — | Image URL |
| `duration_s` | number | `5` | Clip duration in seconds |
| `fps` | number | `25` | Frame rate |
| `width` | number | `1920` | Output width. Auto-detects portrait vs landscape if omitted. |
| `height` | number | `1080` | Output height. Auto-detects portrait vs landscape if omitted. |

**Returns:** `.mp4`

---

### `POST /image/zoom`

Apply Ken Burns zoom/pan effect to a still image, producing a video clip.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_url` | string | — | Image URL |
| `duration_s` | number | `5` | Clip duration in seconds |
| `fps` | number | `25` | Frame rate |
| `zoom_direction` | string | `"in"` | `"in"` \| `"out"` \| `"left"` \| `"right"` \| `"in-left"` \| `"in-right"` |
| `zoom_from` | number | `1.0` | Starting zoom multiplier |
| `zoom_to` | number | `1.05` | Ending zoom multiplier |
| `width` | number | — | Output width. Auto-detected from image orientation if omitted. |
| `height` | number | — | Output height. Auto-detected from image orientation if omitted. |

**Orientation:** Portrait images default to `1080x1920`. Landscape/square images default to `1920x1080`. Pass explicit `width` and `height` to override.

**Returns:** `.mp4`

**Example:**
```bash
curl -X POST http://localhost:3223/image/zoom \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://your-host.com/photo.jpg",
    "duration_s": 5,
    "fps": 25,
    "zoom_direction": "in",
    "zoom_from": 1.0,
    "zoom_to": 1.08
  }' \
  -o zoom.mp4
```

---

## Render Endpoints

---

### `POST /render/episode`

Full pipeline in one call: ordered image/video clips + audio track → assembled video with optional background music. For more control over per-clip transitions, use `/video/assemble` + `/video/mix` instead.

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `clips` | object[] | — | Ordered clip array with `url`, `type`, `duration_s`, `zoom_direction` |
| `audio_url` | string | — | Main audio track URL (required) |
| `music_url` | string | — | Optional background music URL |
| `music_volume` | number | `0.08` | Background music volume |
| `loop_music` | bool | `true` | Loop music |
| `width` | number | `1920` | Output width |
| `height` | number | `1080` | Output height |
| `fps` | number | `25` | Frame rate |

**Returns:** `.mp4`

---

### `POST /render/probe`

Return ffprobe metadata for any file type (audio, video, image).

**Body parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | File URL of any type |

**Returns:** JSON ffprobe output

---

## Utility Endpoints (gnh1201 Compatibility)

These endpoints maintain drop-in compatibility with the `gnh1201/ffmpeg-api` container they replace.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /convert/audio/to/mp3` | POST | Convert any audio format to MP3 |
| `POST /convert/audio/to/wav` | POST | Convert any audio format to WAV |
| `POST /convert/video/to/mp4` | POST | Convert any video format to MP4 |
| `POST /convert/image/to/jpg` | POST | Convert any image format to JPG |
| `POST /video/extract/audio` | POST | Extract audio track from a video file |
| `POST /video/extract/images` | POST | Extract frames from video as base64 JPGs |
| `POST /probe` | POST | ffprobe metadata (compat alias for `/render/probe`) |

All compat endpoints accept multipart upload with field name `file`, or JSON body with `url` field.

---

## Recommended Production Pipelines

### Podcast episode

```
1. POST /audio/assemble    clips[] + pause_after_ms → episode.mp3
2. POST /audio/mix-music   episode.mp3 + music.mp3  → final.mp3   (optional)
```

### Video episode with voiceover

```
1. POST /video/assemble    clips[] + transitions    → silent.mp4
2. POST /video/mix         silent.mp4 + vo.mp3 + music.mp3 → final.mp4
```

### Branded video ad (Vogue cover style)

```
1. POST /video/assemble    background clips          → silent.mp4
2. POST /video/overlay     silent.mp4 + frame.png   → branded.mp4
3. POST /video/mix         branded.mp4 + music.mp3  → final.mp4
```

### Quick image-to-video with Ken Burns

```
1. POST /image/zoom        photo.jpg                → clip.mp4
2. POST /video/mix         clip.mp4 + audio.mp3     → final.mp4
```

---

## Docker

**Image:** built locally from `/ffmpeg-media-api/Dockerfile`  
**Base:** `node:20-alpine` + `ffmpeg` (Alpine package)  
**Port:** `3223` (host) → `3000` (container)  

```yaml
services:
  ffmpeg-media-api:
    image: localhost/ffmpeg-media-api:latest
    pull_policy: never
    container_name: ffmpeg-media-api
    ports:
      - "3223:3000"
    restart: unless-stopped
```

**Rebuild after code changes:**
```bash
docker build -t ffmpeg-media-api . && \
docker stop ffmpeg-media-api && \
docker rm ffmpeg-media-api && \
docker run -d --name ffmpeg-media-api -p 3223:3000 --restart unless-stopped ffmpeg-media-api
```
