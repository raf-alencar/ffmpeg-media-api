# Contributing

Contributions are welcome. This document covers how to report bugs, suggest features, and submit pull requests.

---

## Reporting bugs

Open an issue with:

- The endpoint you were calling
- The exact request body (redact any private URLs)
- The full error response including the `details` field (this contains ffmpeg stderr)
- The ffmpeg version if you're not using the provided Docker image

The `details` field in error responses contains the raw ffmpeg stderr output — this is almost always enough to diagnose the problem.

---

## Suggesting features

Open an issue describing:

- The use case (what pipeline are you building?)
- The input/output you'd expect
- The ffmpeg command you'd use manually, if you know it

New endpoints are straightforward to add. The more specific the ffmpeg command, the faster it gets implemented.

---

## Pull requests

### Setup

```bash
git clone https://github.com/your-username/ffmpeg-media-api.git
cd ffmpeg-media-api
npm install
```

You'll need ffmpeg installed locally for testing outside Docker:

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg
```

Or test inside Docker:

```bash
docker build -t ffmpeg-media-api-dev .
docker run --rm -p 3223:3000 ffmpeg-media-api-dev
```

### Adding an endpoint

1. Add the route handler in `server.js` following the existing pattern:
   - Accept JSON body with `*_url` fields and/or multipart upload
   - Use `fetchUrl()` to retrieve remote files to `/tmp`
   - Use `tmpFile()` to generate output paths
   - Use `cleanup()` in both success and error paths
   - Use `sendFile()` to return the binary output
   - Use `ffmpegError()` for consistent error responses

2. Add the endpoint to both the `GET /` listing and the `GET /endpoints` array

3. Add the endpoint to `CHANGELOG.md` under an `[Unreleased]` section

4. Add the endpoint to `docs/API.md` following the existing format

### Code style

- No external dependencies beyond `express` and `multer`
- No async libraries — Node's built-in `https`/`http` for fetching, `execSync` for ffmpeg calls
- Every route handler cleans up its own temp files in both success and error paths
- ffmpeg stderr is always surfaced in error responses — never swallow it

### Before submitting

- Test the endpoint with a real file via curl
- Confirm temp files are cleaned up after the request (check `/tmp` before and after)
- Confirm error responses return JSON with `error` and `details` fields

---

## Scope

This project is intentionally minimal — a thin HTTP wrapper around ffmpeg with no database, no job queue, no authentication, and no file storage. Pull requests that add these concerns will not be merged. If you need those features, this project is a good base to fork from.

Endpoints that are in scope: anything that maps cleanly to one or a small number of ffmpeg commands and fits the URL-in / binary-out model.
