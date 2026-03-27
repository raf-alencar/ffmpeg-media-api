# ffmpeg-media-api

A self-hosted HTTP API for audio and video production via ffmpeg. Designed for use in automated pipelines — n8n, Make, custom workflows — where you need to process media without sending binary files back and forth.

All endpoints accept **public URLs** as input. The server fetches files internally, processes them, and returns the output directly. No multipart upload overhead for large files.

---

## What it does

**Audio**
- Normalize loudness (EBU R128)
- Concatenate clips in sequence
- Assemble podcast episodes with per-clip silence gaps
- Mix background music under speech
- Trim and fade

**Video**
- Assemble image and video clips with per-clip Ken Burns effects and crossfade transitions
- Composite transparent PNG overlays (text frames, logos, cover treatments)
- Add voiceover and background music
- Trim, fade to black or white, extract audio

**Image**
- Convert still images to video clips
- Apply Ken Burns zoom/pan effects

**Utility**
- ffprobe metadata for any file type
- Format conversion (audio, video, image)

---

## Quick start

### Docker Compose (recommended)

```yaml
services:
  ffmpeg-media-api:
    image: ghcr.io/your-username/ffmpeg-media-api:latest
    container_name: ffmpeg-media-api
    ports:
      - "3223:3000"
    restart: unless-stopped
```

Or build from source:

```yaml
services:
  ffmpeg-media-api:
    build: .
    container_name: ffmpeg-media-api
    ports:
      - "3223:3000"
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Build manually

```bash
git clone https://github.com/your-username/ffmpeg-media-api.git
cd ffmpeg-media-api
docker build -t ffmpeg-media-api .
docker run -d --name ffmpeg-media-api -p 3223:3000 --restart unless-stopped ffmpeg-media-api
```

### Verify

```bash
curl http://localhost:3223/
```

Returns a JSON listing of all available endpoints.

---

## Usage

All endpoints accept a JSON body with `*_url` fields pointing to publicly accessible files. Multipart file upload is also supported as a fallback.

### Normalize audio

```bash
curl -X POST http://localhost:3223/audio/normalize \
  -H "Content-Type: application/json" \
  -d '{"audio_url": "https://your-host.com/speech.mp3"}' \
  -o normalized.mp3
```

### Assemble a podcast episode

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

### Assemble a video sequence with Ken Burns and transitions

```bash
curl -X POST http://localhost:3223/video/assemble \
  -H "Content-Type: application/json" \
  -d '{
    "clips": [
      {
        "url": "https://your-host.com/photo.jpg",
        "type": "image",
        "duration_s": 5,
        "zoom_direction": "in",
        "transition_out": {"type": "fade", "duration_s": 0.5}
      },
      {
        "url": "https://your-host.com/clip.mp4",
        "type": "video",
        "keep_audio": false,
        "transition_out": {"type": "cut"}
      }
    ],
    "width": 1920,
    "height": 1080,
    "fps": 25
  }' \
  -o assembled.mp4
```

### Composite a PNG overlay

```bash
curl -X POST http://localhost:3223/video/overlay \
  -H "Content-Type: application/json" \
  -d '{
    "video_url": "https://your-host.com/background.mp4",
    "overlay_url": "https://your-host.com/frame.png",
    "position": "center",
    "scale_to_fit": true
  }' \
  -o output.mp4
```

---

## Common pipelines

### Podcast episode
```
POST /audio/assemble   → episode.mp3
POST /audio/mix-music  → episode-with-music.mp3   (optional)
```

### Video episode with voiceover
```
POST /video/assemble   → silent.mp4
POST /video/mix        → final.mp4
```

### Branded video (overlay treatment)
```
POST /video/assemble   → silent.mp4
POST /video/overlay    → branded.mp4
POST /video/mix        → final.mp4
```

---

## Full API reference

See [docs/API.md](docs/API.md) for complete endpoint documentation including all parameters, defaults, and examples.

---

## Requirements

- Docker
- Publicly accessible URLs for input files (or use multipart upload)

No other dependencies. ffmpeg is installed inside the container.

---

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `PORT` | `3000` | Port the server listens on inside the container |

---

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.

FFmpeg is a dependency with its own license terms. See the [Dependency Notice](LICENSE#dependency-notice) in the license file and [ffmpeg.org/legal.html](https://ffmpeg.org/legal.html) for details.
