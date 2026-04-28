const express = require("express");
const multer = require("multer");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpFile(ext = "") {
  return path.join(os.tmpdir(), `ffapi_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
}

function cleanup(...files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }
}

function cleanupAll(files) {
  if (!Array.isArray(files)) return;
  for (const f of files) cleanup(f);
}

function fetchUrl(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch ${url}: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(destPath); });
    }).on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function resolveInput(req, fieldName = "audio") {
  // Returns { localPath, isTemp } — caller is responsible for cleanup if isTemp
  const url = req.body?.[`${fieldName}_url`] || req.body?.url;
  if (url) {
    const ext = path.extname(new URL(url).pathname) || ".tmp";
    const dest = tmpFile(ext);
    await fetchUrl(url, dest);
    return { localPath: dest, isTemp: true };
  }
  const file = req.file || req.files?.[fieldName]?.[0];
  if (file) return { localPath: file.path, isTemp: true };
  throw new Error(`No input provided. Supply a URL in body.${fieldName}_url or upload a file.`);
}

async function resolveMultipleInputs(req, fieldName = "audio") {
  const urls = req.body?.urls;
  if (urls && Array.isArray(urls)) {
    const paths = [];
    for (const url of urls) {
      const ext = path.extname(new URL(url).pathname) || ".tmp";
      const dest = tmpFile(ext);
      await fetchUrl(url, dest);
      paths.push({ localPath: dest, isTemp: true, originalname: path.basename(new URL(url).pathname) });
    }
    return paths;
  }
  const files = req.files?.[fieldName];
  if (files && files.length > 0) {
    return files.map(f => ({ localPath: f.path, isTemp: true, originalname: f.originalname }));
  }
  throw new Error(`No inputs provided. Supply URLs array in body.urls or upload multiple files.`);
}

function sendFile(res, filePath, filename, mimeType = "audio/mpeg") {
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("end", () => cleanup(filePath));
  stream.on("error", () => cleanup(filePath));
}

function ffmpegError(res, err, context) {
  const stderr = err.stderr?.toString() ?? err.message;
  console.error(`[${context}] ffmpeg error:`, stderr);
  res.status(500).json({ error: `${context} failed`, details: stderr });
}

// atempo only accepts 0.5–2.0; chain multiple filters for values outside that range
function buildAtempoChain(speed) {
  const filters = [];
  let s = speed;
  while (s > 2.0) { filters.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5) { filters.push("atempo=0.5"); s *= 2.0; }
  filters.push(`atempo=${s.toFixed(6)}`);
  return filters.join(",");
}

// ── Multer ────────────────────────────────────────────────────────────────────

const upload = multer({ dest: os.tmpdir() });

// ── GET / ─────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "ffmpeg-media-api",
    version: "1.0.0",
    note: "All endpoints accept either JSON body with *_url fields OR multipart/form-data binary upload.",
    endpoints: [
      // AUDIO
      { path: "/audio/normalize",   methods: ["POST"], description: "EBU R128 loudnorm. Body: { audio_url } or upload field: audio." },
      { path: "/audio/concat",      methods: ["POST"], description: "Join audio files in order. Body: { urls: [] } or upload field: audio (multiple)." },
      { path: "/audio/assemble",    methods: ["POST"], description: "Podcast assembly: ordered clips + pause_after_ms gaps. Body: { clips: [{url, pause_after_ms}], normalize, output_format, speed }." },
      { path: "/audio/mix-music",   methods: ["POST"], description: "Layer background music under speech. Body: { speech_url, music_url, music_volume, loop_music }." },
      { path: "/audio/trim",        methods: ["POST"], description: "Trim audio to start/end points. Body: { audio_url, start_s, end_s }." },
      { path: "/audio/fade",        methods: ["POST"], description: "Fade audio in, out, or both. Body: { audio_url, fade_type, fade_duration_s }." },
      { path: "/audio/probe",       methods: ["POST"], description: "ffprobe metadata. Body: { audio_url } or upload field: audio." },
      { path: "/audio/sha256",      methods: ["POST"], description: "ffprobe metadata. Body: { audio_url } or upload field: audio." },
      // VIDEO
      { path: "/video/concat",      methods: ["POST"], description: "Join video clips. Body: { urls: [] } or upload field: video (multiple)." },
      { path: "/video/add-audio",   methods: ["POST"], description: "Attach audio to video. Body: { video_url, audio_url }." },
      { path: "/video/transition",  methods: ["POST"], description: "Concat clips with crossfade. Body: { urls: [], duration_s }." },
      { path: "/video/trim",        methods: ["POST"], description: "Trim video to start/end points. Body: { video_url, start_s, end_s }." },
      { path: "/video/fade",        methods: ["POST"], description: "Fade video to black or white. Body: { video_url, fade_type, fade_duration_s, fade_color }." },
      { path: "/video/overlay",     methods: ["POST"], description: "Composite a transparent PNG over a video. Body: { video_url, overlay_url, position, scale_to_fit, opacity, x, y }." },
      { path: "/video/mix-music",   methods: ["POST"], description: "Layer background music under video audio. Body: { video_url, music_url, music_volume, loop_music }." },
      { path: "/video/probe",       methods: ["POST"], description: "ffprobe metadata for video. Body: { video_url } or upload." },
      // IMAGE
      { path: "/image/to-video",    methods: ["POST"], description: "Still image to video clip. Body: { image_url, duration_s, fps }." },
      { path: "/image/zoom",        methods: ["POST"], description: "Ken Burns zoom/pan. Body: { image_url, duration_s, fps, zoom_direction }." },
      // RENDER
      { path: "/render/episode",    methods: ["POST"], description: "Full assembly: image/video clips + audio → video. Body: { clips: [{url, type, duration_s}], audio_url, music_url, music_volume }." },
      { path: "/render/probe",      methods: ["POST"], description: "ffprobe any file. Body: { url } or upload." },
      // VIDEO ASSEMBLE + MIX
      { path: "/video/assemble",    methods: ["POST"], description: "Visual sequencer: images + videos, per-clip Ken Burns + transitions, silent output. Body: { clips: [{url, type, duration_s, zoom_direction, transition_out}], width, height, fps }." },
      { path: "/video/mix",         methods: ["POST"], description: "Add voiceover + background music to a video. Body: { video_url, voiceover_url, voiceover_volume, music_url, music_volume, loop_music, replace_original }." },
      // UTIL (gnh1201 compatibility)
      { path: "/convert/audio/to/mp3",      methods: ["POST"], description: "Convert audio to mp3." },
      { path: "/convert/audio/to/wav",      methods: ["POST"], description: "Convert audio to wav." },
      { path: "/convert/video/to/mp4",      methods: ["POST"], description: "Convert video to mp4." },
      { path: "/convert/image/to/jpg",      methods: ["POST"], description: "Convert image to jpg." },
      { path: "/video/extract/audio",       methods: ["POST"], description: "Extract audio track from video." },
      { path: "/video/extract/images",      methods: ["POST"], description: "Extract frames from video." },
      { path: "/probe",                     methods: ["POST"], description: "ffprobe (gnh1201 compat)." },
      { path: "/endpoints",                 methods: ["GET"],  description: "List all endpoints." },
    ]
  });
});

app.get("/endpoints", (req, res) => {
  res.json([
    { path: "/audio/normalize",          methods: ["POST"] },
    { path: "/audio/concat",             methods: ["POST"] },
    { path: "/audio/assemble",           methods: ["POST"] },
    { path: "/audio/mix-music",          methods: ["POST"] },
    { path: "/audio/trim",               methods: ["POST"] },
    { path: "/audio/fade",               methods: ["POST"] },
    { path: "/audio/probe",              methods: ["POST"] },
    { path: "/audio/sha256",             methods: ["POST"] },
    { path: "/video/concat",             methods: ["POST"] },
    { path: "/video/add-audio",          methods: ["POST"] },
    { path: "/video/transition",         methods: ["POST"] },
    { path: "/video/trim",               methods: ["POST"] },
    { path: "/video/fade",               methods: ["POST"] },
    { path: "/video/overlay",            methods: ["POST"] },
    { path: "/video/mix-music",          methods: ["POST"] },
    { path: "/video/probe",              methods: ["POST"] },
    { path: "/image/to-video",           methods: ["POST"] },
    { path: "/image/zoom",               methods: ["POST"] },
    { path: "/render/episode",           methods: ["POST"] },
    { path: "/render/probe",             methods: ["POST"] },
    { path: "/video/assemble",           methods: ["POST"] },
    { path: "/video/mix",                methods: ["POST"] },
    { path: "/convert/audio/to/mp3",     methods: ["POST"] },
    { path: "/convert/audio/to/wav",     methods: ["POST"] },
    { path: "/convert/video/to/mp4",     methods: ["POST"] },
    { path: "/convert/image/to/jpg",     methods: ["POST"] },
    { path: "/video/extract/audio",      methods: ["POST"] },
    { path: "/video/extract/images",     methods: ["POST"] },
    { path: "/probe",                    methods: ["POST"] },
    { path: "/",                         methods: ["GET"]  },
    { path: "/endpoints",                methods: ["GET"]  },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// AUDIO
// ═════════════════════════════════════════════════════════════════════════════

// POST /audio/normalize
// Body: { audio_url, target_lufs, true_peak, lra, ar } OR multipart field: audio
app.post("/audio/normalize", upload.single("audio"), async (req, res) => {
  let input, output;
  try {
    ({ localPath: input } = await resolveInput(req, "audio"));
    output = tmpFile(".mp3");

    const lufs     = parseFloat(req.body?.target_lufs ?? "-16");
    const truePeak = parseFloat(req.body?.true_peak   ?? "-1.5");
    const lra      = parseFloat(req.body?.lra         ?? "11");
    const ar       = parseInt(req.body?.ar             ?? "44100", 10);
    const filter   = `loudnorm=I=${lufs}:TP=${truePeak}:LRA=${lra}:linear=true`;

    execSync(`ffmpeg -y -i "${input}" -af "${filter}" -ar ${ar} -c:a libmp3lame -q:a 2 "${output}"`, { stdio: "pipe" });
    cleanup(input);
    sendFile(res, output, "normalized.mp3", "audio/mpeg");
  } catch (err) {
    cleanup(input, output);
    ffmpegError(res, err, "audio/normalize");
  }
});

// POST /audio/concat
// Body: { urls: [] } OR multipart field: audio (multiple)
app.post("/audio/concat", upload.fields([{ name: "audio", maxCount: 500 }]), async (req, res) => {
  const temps = [];
  let listFile, output;
  try {
    const inputs = await resolveMultipleInputs(req, "audio");
    const sorted = inputs.sort((a, b) => a.originalname.localeCompare(b.originalname, undefined, { numeric: true }));
    sorted.forEach(f => temps.push(f.localPath));

    listFile = tmpFile(".txt");
    output   = tmpFile(".mp3");
    const ar = parseInt(req.body?.ar ?? "44100", 10);

    fs.writeFileSync(listFile, sorted.map(f => `file '${f.localPath}'`).join("\n"));
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -q:a 2 -ar ${ar} "${output}"`, { stdio: "pipe" });

    cleanupAll(temps);
    cleanup(listFile);
    sendFile(res, output, "concat.mp3", "audio/mpeg");
  } catch (err) {
    cleanupAll(temps);
    cleanup(listFile, output);
    ffmpegError(res, err, "audio/concat");
  }
});

// POST /audio/assemble
// The podcast assembly endpoint. Reads seq-ordered clips + pause_after_ms.
// Body: {
//   clips: [ { url, pause_after_ms } ],
//   normalize: bool,
//   music_url: optional,
//   music_volume: 0.08,
//   loop_music: true,
//   output_format: "mp3",
//   speed: 1.0   — optional atempo speed multiplier applied after all other processing
// }
app.post("/audio/assemble", async (req, res) => {
  const { clips, normalize = true, music_url, music_volume = 0.08, loop_music = true } = req.body;
  if (!clips || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "Body must include clips array: [{ url, pause_after_ms }]" });
  }

  const speed = parseFloat(req.body?.speed ?? "1.0");
  if (isNaN(speed) || speed <= 0) {
    return res.status(400).json({ error: "speed must be a positive number" });
  }

  const temps    = [];
  const segments = [];
  let listFile, merged, normalized, withMusic, sped;

  try {
    const ar = parseInt(req.body?.ar ?? "44100", 10);

    // 1. Fetch all clip URLs and generate silence files for pauses
    for (const clip of clips) {
      if (!clip.url) continue;

      const ext  = path.extname(new URL(clip.url).pathname) || ".mp3";
      const dest = tmpFile(ext);
      await fetchUrl(clip.url, dest);
      temps.push(dest);
      segments.push(dest);

      // Generate silence for pause_after_ms
      const pauseMs = parseInt(clip.pause_after_ms ?? "0", 10);
      if (pauseMs > 0) {
        const silenceDuration = (pauseMs / 1000).toFixed(3);
        const silenceFile = tmpFile(".mp3");
        execSync(
          `ffmpeg -y -f lavfi -i anullsrc=r=${ar}:cl=stereo -t ${silenceDuration} -c:a libmp3lame -q:a 2 "${silenceFile}"`,
          { stdio: "pipe" }
        );
        temps.push(silenceFile);
        segments.push(silenceFile);
      }
    }

    // 2. Write concat list and merge
    listFile = tmpFile(".txt");
    merged   = tmpFile(".mp3");
    fs.writeFileSync(listFile, segments.map(f => `file '${f}'`).join("\n"));
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -q:a 2 -ar ${ar} "${merged}"`, { stdio: "pipe" });
    cleanup(listFile);
    cleanupAll(temps);

    // 3. Optional normalize pass
    let current = merged;
    if (normalize) {
      normalized = tmpFile(".mp3");
      const filter = `loudnorm=I=-16:TP=-1.5:LRA=11:linear=true`;
      execSync(`ffmpeg -y -i "${current}" -af "${filter}" -ar ${ar} -c:a libmp3lame -q:a 2 "${normalized}"`, { stdio: "pipe" });
      cleanup(current);
      current = normalized;
    }

    // 4. Optional background music mix
    if (music_url) {
      const musicExt  = path.extname(new URL(music_url).pathname) || ".mp3";
      const musicFile = tmpFile(musicExt);
      await fetchUrl(music_url, musicFile);
      withMusic = tmpFile(".mp3");

      const loopFlag = loop_music ? "-stream_loop -1" : "";
      const vol      = parseFloat(music_volume);
      execSync(
        `ffmpeg -y -i "${current}" ${loopFlag} -vn -i "${musicFile}" ` +
        `-filter_complex "[1:a]volume=${vol}[music];[0:a][music]amix=inputs=2:duration=first" ` +
        `-c:a libmp3lame -q:a 2 -ar ${ar} "${withMusic}"`,
        { stdio: "pipe" }
      );
      cleanup(current, musicFile);
      current = withMusic;
    }

    // 5. Optional speed adjustment via atempo
    if (speed !== 1.0) {
      sped = tmpFile(".mp3");
      // atempo accepts 0.5–2.0; chain filters for values outside that range
      const atempoFilters = buildAtempoChain(speed);
      execSync(`ffmpeg -y -i "${current}" -af "${atempoFilters}" -c:a libmp3lame -q:a 2 -ar ${ar} "${sped}"`, { stdio: "pipe" });
      cleanup(current);
      current = sped;
    }

    sendFile(res, current, "episode.mp3", "audio/mpeg");

  } catch (err) {
    cleanupAll(temps);
    cleanup(listFile, merged, normalized, withMusic, sped);
    ffmpegError(res, err, "audio/assemble");
  }
});

// POST /audio/mix-music
// Body: { speech_url, music_url, music_volume, loop_music, ar }
app.post("/audio/mix-music", upload.fields([{ name: "speech" }, { name: "music" }]), async (req, res) => {
  let speechFile, musicFile, output;
  try {
    const speechUrl = req.body?.speech_url;
    const musicUrl  = req.body?.music_url;
    const ar        = parseInt(req.body?.ar ?? "44100", 10);
    const vol       = parseFloat(req.body?.music_volume ?? "0.08");
    const loop      = req.body?.loop_music !== "false";

    speechFile = tmpFile(".mp3");
    musicFile  = tmpFile(".mp3");
    output     = tmpFile(".mp3");

    if (speechUrl) await fetchUrl(speechUrl, speechFile);
    else { const f = req.files?.speech?.[0]; if (f) fs.copyFileSync(f.path, speechFile); else throw new Error("No speech input"); }

    if (musicUrl) await fetchUrl(musicUrl, musicFile);
    else { const f = req.files?.music?.[0];  if (f) fs.copyFileSync(f.path, musicFile);  else throw new Error("No music input"); }

    const loopFlag = loop ? "-stream_loop -1" : "";
    // -vn on music input strips embedded album art / video streams (common in MP3s)
    execSync(
      `ffmpeg -y -i "${speechFile}" ${loopFlag} -vn -i "${musicFile}" ` +
      `-filter_complex "[1:a]volume=${vol}[music];[0:a][music]amix=inputs=2:duration=first" ` +
      `-c:a libmp3lame -q:a 2 -ar ${ar} "${output}"`,
      { stdio: "pipe" }
    );
    cleanup(speechFile, musicFile);
    sendFile(res, output, "mixed.mp3", "audio/mpeg");
  } catch (err) {
    cleanup(speechFile, musicFile, output);
    ffmpegError(res, err, "audio/mix-music");
  }
});

// POST /audio/trim
// Body: { audio_url, start_s, end_s }
// start_s: start point in seconds (default 0)
// end_s: end point in seconds (omit to trim to end of file)
app.post("/audio/trim", async (req, res) => {
  let input, output;
  try {
    const { audio_url, start_s = 0, end_s } = req.body;
    if (!audio_url) return res.status(400).json({ error: "Requires audio_url" });

    input  = tmpFile(".mp3");
    output = tmpFile(".mp3");
    await fetchUrl(audio_url, input);

    const startFlag = `-ss ${parseFloat(start_s)}`;
    const endFlag   = end_s ? `-to ${parseFloat(end_s)}` : "";

    execSync(`ffmpeg -y ${startFlag} -i "${input}" ${endFlag} -c:a libmp3lame -q:a 2 "${output}"`, { stdio: "pipe" });
    cleanup(input);
    sendFile(res, output, "trimmed.mp3", "audio/mpeg");
  } catch (err) {
    cleanup(input, output);
    ffmpegError(res, err, "audio/trim");
  }
});

// POST /audio/fade
// Body: { audio_url, fade_type, fade_duration_s }
// fade_type: "in" | "out" | "both" (default: "out")
// fade_duration_s: seconds for the fade (default: 1.0)
app.post("/audio/fade", async (req, res) => {
  let input, output;
  try {
    const { audio_url, fade_type = "out", fade_duration_s = 1.0 } = req.body;
    if (!audio_url) return res.status(400).json({ error: "Requires audio_url" });

    input  = tmpFile(".mp3");
    output = tmpFile(".mp3");
    await fetchUrl(audio_url, input);

    const fd = parseFloat(fade_duration_s);

    // Probe duration so we can calculate fade-out start point
    const probe    = JSON.parse(execSync(`ffprobe -v quiet -print_format json -show_format "${input}"`, { stdio: "pipe" }).toString());
    const duration = parseFloat(probe.format.duration);
    const fadeOutStart = Math.max(0, duration - fd).toFixed(3);

    let filter;
    switch (fade_type) {
      case "in":
        filter = `afade=t=in:st=0:d=${fd}`;
        break;
      case "both":
        filter = `afade=t=in:st=0:d=${fd},afade=t=out:st=${fadeOutStart}:d=${fd}`;
        break;
      case "out":
      default:
        filter = `afade=t=out:st=${fadeOutStart}:d=${fd}`;
        break;
    }

    execSync(`ffmpeg -y -i "${input}" -af "${filter}" -c:a libmp3lame -q:a 2 "${output}"`, { stdio: "pipe" });
    cleanup(input);
    sendFile(res, output, "faded.mp3", "audio/mpeg");
  } catch (err) {
    cleanup(input, output);
    ffmpegError(res, err, "audio/fade");
  }
});

// POST /audio/probe
app.post("/audio/probe", upload.single("audio"), async (req, res) => {
  let input;
  try {
    ({ localPath: input } = await resolveInput(req, "audio"));
    const result = execSync(`ffprobe -v quiet -print_format json -show_streams -show_format "${input}"`, { stdio: "pipe" });
    cleanup(input);
    res.json(JSON.parse(result.toString()));
  } catch (err) {
    cleanup(input);
    ffmpegError(res, err, "audio/probe");
  }
});

// POST /audio/sha256
app.post("/audio/sha256", upload.single("audio"), async (req, res) => {
  let input;

  try {
    ({ localPath: input } = await resolveInput(req, "audio"));

    const buffer = fs.readFileSync(input);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const stats = fs.statSync(input);

    res.json({
      sha256,
      size_bytes: stats.size,
      debug: {
        input_path: input,
        original_name: req.file?.originalname ?? null,
        mime_type: req.file?.mimetype ?? null,
        body_audio_url: req.body?.audio_url ?? null,
        body_url: req.body?.url ?? null,
      },
    });

    cleanup(input);
  } catch (err) {
    cleanup(input);
    ffmpegError(res, err, "audio/sha256");
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// VIDEO
// ═════════════════════════════════════════════════════════════════════════════

// POST /video/concat
// Body: { urls: [] } OR multipart field: video (multiple)
app.post("/video/concat", upload.fields([{ name: "video", maxCount: 100 }]), async (req, res) => {
  const temps = [];
  let listFile, output;
  try {
    const inputs = await resolveMultipleInputs(req, "video");
    const sorted = inputs.sort((a, b) => a.originalname.localeCompare(b.originalname, undefined, { numeric: true }));
    sorted.forEach(f => temps.push(f.localPath));

    listFile = tmpFile(".txt");
    output   = tmpFile(".mp4");

    fs.writeFileSync(listFile, sorted.map(f => `file '${f.localPath}'`).join("\n"));
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${output}"`, { stdio: "pipe" });

    cleanupAll(temps);
    cleanup(listFile);
    sendFile(res, output, "concat.mp4", "video/mp4");
  } catch (err) {
    cleanupAll(temps);
    cleanup(listFile, output);
    ffmpegError(res, err, "video/concat");
  }
});

// POST /video/add-audio
// Body: { video_url, audio_url, replace_audio }
// replace_audio: true = replace existing audio, false = mix with existing (default: true)
app.post("/video/add-audio", async (req, res) => {
  let videoFile, audioFile, output;
  try {
    const { video_url, audio_url, replace_audio = true } = req.body;
    if (!video_url || !audio_url) return res.status(400).json({ error: "Requires video_url and audio_url" });

    videoFile = tmpFile(".mp4");
    audioFile = tmpFile(".mp3");
    output    = tmpFile(".mp4");

    await fetchUrl(video_url, videoFile);
    await fetchUrl(audio_url, audioFile);

    if (replace_audio) {
      execSync(
        `ffmpeg -y -i "${videoFile}" -i "${audioFile}" -map 0:v -map 1:a -c:v copy -shortest "${output}"`,
        { stdio: "pipe" }
      );
    } else {
      execSync(
        `ffmpeg -y -i "${videoFile}" -i "${audioFile}" ` +
        `-filter_complex "[0:a][1:a]amix=inputs=2:duration=first" ` +
        `-c:v copy "${output}"`,
        { stdio: "pipe" }
      );
    }

    cleanup(videoFile, audioFile);
    sendFile(res, output, "with-audio.mp4", "video/mp4");
  } catch (err) {
    cleanup(videoFile, audioFile, output);
    ffmpegError(res, err, "video/add-audio");
  }
});

// POST /video/transition
// Body: { urls: [], transition_duration_s, transition_type }
// transition_type: "fade" (default) | "cut"
app.post("/video/transition", async (req, res) => {
  const temps = [];
  let output;
  try {
    const { urls, transition_duration_s = 0.5, transition_type = "fade" } = req.body;
    if (!urls || urls.length < 2) return res.status(400).json({ error: "Requires at least 2 URLs" });

    for (const url of urls) {
      const ext  = path.extname(new URL(url).pathname) || ".mp4";
      const dest = tmpFile(ext);
      await fetchUrl(url, dest);
      temps.push(dest);
    }

    output = tmpFile(".mp4");

    if (transition_type === "cut") {
      // Simple cut — re-encode for uniform codec
      const listFile = tmpFile(".txt");
      fs.writeFileSync(listFile, temps.map(f => `file '${f}'`).join("\n"));
      execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -c:a aac "${output}"`, { stdio: "pipe" });
      cleanup(listFile);
    } else {
      // Crossfade using xfade filter — chain across all clips
      // Get duration of each clip for offset calculation
      const durations = temps.map(f => {
        const probe = JSON.parse(execSync(`ffprobe -v quiet -print_format json -show_format "${f}"`, { stdio: "pipe" }).toString());
        return parseFloat(probe.format.duration);
      });

      const td = parseFloat(transition_duration_s);
      let filterComplex = "";
      let inputs = "";
      temps.forEach((f, i) => { inputs += `-i "${f}" `; });

      if (temps.length === 2) {
        const offset = durations[0] - td;
        filterComplex = `[0:v][1:v]xfade=transition=fade:duration=${td}:offset=${offset}[vout];` +
                        `[0:a][1:a]acrossfade=d=${td}[aout]`;
        execSync(`ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -c:a aac "${output}"`, { stdio: "pipe" });
      } else {
        // TODO: chain xfade for 3+ clips — for now fall back to concat
        const listFile = tmpFile(".txt");
        fs.writeFileSync(listFile, temps.map(f => `file '${f}'`).join("\n"));
        execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -c:a aac "${output}"`, { stdio: "pipe" });
        cleanup(listFile);
      }
    }

    cleanupAll(temps);
    sendFile(res, output, "transition.mp4", "video/mp4");
  } catch (err) {
    cleanupAll(temps);
    cleanup(output);
    ffmpegError(res, err, "video/transition");
  }
});

// POST /video/trim
// Body: { video_url, start_s, end_s }
app.post("/video/trim", async (req, res) => {
  let videoFile, output;
  try {
    const { video_url, start_s = 0, end_s } = req.body;
    if (!video_url) return res.status(400).json({ error: "Requires video_url" });

    videoFile = tmpFile(".mp4");
    output    = tmpFile(".mp4");
    await fetchUrl(video_url, videoFile);

    const startFlag = `-ss ${parseFloat(start_s)}`;
    const endFlag   = end_s ? `-to ${parseFloat(end_s)}` : "";

    execSync(`ffmpeg -y ${startFlag} -i "${videoFile}" ${endFlag} -c copy "${output}"`, { stdio: "pipe" });
    cleanup(videoFile);
    sendFile(res, output, "trimmed.mp4", "video/mp4");
  } catch (err) {
    cleanup(videoFile, output);
    ffmpegError(res, err, "video/trim");
  }
});

// POST /video/fade
// Body: { video_url, fade_type, fade_duration_s, fade_color }
// fade_type: "in" | "out" | "both" (default: "out")
// fade_duration_s: seconds for the fade (default: 1.0)
// fade_color: "black" (default) | "white"
app.post("/video/fade", async (req, res) => {
  let videoFile, output;
  try {
    const { video_url, fade_type = "out", fade_duration_s = 1.0, fade_color = "black" } = req.body;
    if (!video_url) return res.status(400).json({ error: "Requires video_url" });

    videoFile = tmpFile(".mp4");
    output    = tmpFile(".mp4");
    await fetchUrl(video_url, videoFile);

    const fd = parseFloat(fade_duration_s);
    const color = fade_color === "white" ? "white" : "black";

    // Probe duration for fade-out start calculation
    const probe    = JSON.parse(execSync(`ffprobe -v quiet -print_format json -show_format "${videoFile}"`, { stdio: "pipe" }).toString());
    const duration = parseFloat(probe.format.duration);
    const fadeOutStart = Math.max(0, duration - fd).toFixed(3);

    // Build video and audio filter chains
    let vFilter, aFilter;
    switch (fade_type) {
      case "in":
        vFilter = `fade=t=in:st=0:d=${fd}:color=${color}`;
        aFilter = `afade=t=in:st=0:d=${fd}`;
        break;
      case "both":
        vFilter = `fade=t=in:st=0:d=${fd}:color=${color},fade=t=out:st=${fadeOutStart}:d=${fd}:color=${color}`;
        aFilter = `afade=t=in:st=0:d=${fd},afade=t=out:st=${fadeOutStart}:d=${fd}`;
        break;
      case "out":
      default:
        vFilter = `fade=t=out:st=${fadeOutStart}:d=${fd}:color=${color}`;
        aFilter = `afade=t=out:st=${fadeOutStart}:d=${fd}`;
        break;
    }

    execSync(
      `ffmpeg -y -i "${videoFile}" -vf "${vFilter}" -af "${aFilter}" -c:v libx264 -c:a aac "${output}"`,
      { stdio: "pipe" }
    );
    cleanup(videoFile);
    sendFile(res, output, "faded.mp4", "video/mp4");
  } catch (err) {
    cleanup(videoFile, output);
    ffmpegError(res, err, "video/fade");
  }
});

// POST /video/overlay
// Composite a transparent PNG over a video — full duration, static layer.
// Body: {
//   video_url:      string  — required
//   overlay_url:    string  — required, must be PNG with transparency
//   position:       "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top-center" | "bottom-center" — default "center"
//   x:              number  — custom x offset in pixels (overrides position if set)
//   y:              number  — custom y offset in pixels (overrides position if set)
//   scale_to_fit:   bool    — scale overlay to match video dimensions (default false)
//   opacity:        number  — 0.0–1.0 (default 1.0, fully opaque)
// }
app.post("/video/overlay", async (req, res) => {
  let videoFile, overlayFile, output;
  try {
    const {
      video_url,
      overlay_url,
      position     = "center",
      scale_to_fit = false,
      opacity      = 1.0,
    } = req.body;

    if (!video_url)   return res.status(400).json({ error: "Requires video_url" });
    if (!overlay_url) return res.status(400).json({ error: "Requires overlay_url" });

    videoFile   = tmpFile(".mp4");
    overlayFile = tmpFile(".png");
    output      = tmpFile(".mp4");

    await fetchUrl(video_url,   videoFile);
    await fetchUrl(overlay_url, overlayFile);

    // Probe video dimensions for positioning math
    const probe  = JSON.parse(execSync(`ffprobe -v quiet -print_format json -show_streams "${videoFile}"`, { stdio: "pipe" }).toString());
    const vStream = probe.streams.find(s => s.codec_type === "video");
    const vW      = vStream.width;
    const vH      = vStream.height;

    // Build position expression
    // If explicit x/y provided use those, otherwise map named positions
    let xExpr, yExpr;
    if (req.body.x != null && req.body.y != null) {
      xExpr = parseInt(req.body.x, 10).toString();
      yExpr = parseInt(req.body.y, 10).toString();
    } else {
      switch (position) {
        case "top-left":       xExpr = "0";              yExpr = "0";              break;
        case "top-right":      xExpr = "W-w";            yExpr = "0";              break;
        case "top-center":     xExpr = "(W-w)/2";        yExpr = "0";              break;
        case "bottom-left":    xExpr = "0";              yExpr = "H-h";            break;
        case "bottom-right":   xExpr = "W-w";            yExpr = "H-h";            break;
        case "bottom-center":  xExpr = "(W-w)/2";        yExpr = "H-h";            break;
        case "center":
        default:               xExpr = "(W-w)/2";        yExpr = "(H-h)/2";        break;
      }
    }

    // Build overlay chain
    // [1:v] = overlay PNG input
    // Apply scale if requested, then apply opacity, then composite
    const op = Math.min(1.0, Math.max(0.0, parseFloat(opacity)));

    let overlayPrep;
    if (scale_to_fit) {
      // Scale PNG to exact video dimensions
      overlayPrep = `[1:v]scale=${vW}:${vH}`;
    } else {
      overlayPrep = `[1:v]scale=iw:ih`; // keep native size
    }

    let filterComplex;
    if (op < 1.0) {
      // Apply opacity via colorchannelmixer on alpha channel, then overlay
      filterComplex =
        `${overlayPrep},format=rgba,colorchannelmixer=aa=${op.toFixed(3)}[ov];` +
        `[0:v][ov]overlay=${xExpr}:${yExpr}[vout]`;
    } else {
      filterComplex =
        `${overlayPrep},format=rgba[ov];` +
        `[0:v][ov]overlay=${xExpr}:${yExpr}[vout]`;
    }

    execSync(
      `ffmpeg -y -i "${videoFile}" -i "${overlayFile}" ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[vout]" -map 0:a? -c:v libx264 -pix_fmt yuv420p -c:a copy "${output}"`,
      { stdio: "pipe" }
    );

    cleanup(videoFile, overlayFile);
    sendFile(res, output, "overlaid.mp4", "video/mp4");
  } catch (err) {
    cleanup(videoFile, overlayFile, output);
    ffmpegError(res, err, "video/overlay");
  }
});

// POST /video/mix-music
// Body: { video_url, music_url, music_volume, loop_music }
app.post("/video/mix-music", async (req, res) => {
  let videoFile, musicFile, output;
  try {
    const { video_url, music_url, music_volume = 0.08, loop_music = true } = req.body;
    if (!video_url || !music_url) return res.status(400).json({ error: "Requires video_url and music_url" });

    videoFile = tmpFile(".mp4");
    musicFile = tmpFile(".mp3");
    output    = tmpFile(".mp4");

    await fetchUrl(video_url, videoFile);
    await fetchUrl(music_url, musicFile);

    const loopFlag = loop_music ? "-stream_loop -1" : "";
    const vol      = parseFloat(music_volume);

    execSync(
      `ffmpeg -y -i "${videoFile}" ${loopFlag} -i "${musicFile}" ` +
      `-filter_complex "[0:a]volume=1.0[speech];[1:a]volume=${vol}[music];[speech][music]amix=inputs=2:duration=first[aout]" ` +
      `-map 0:v -map "[aout]" -c:v copy -c:a aac "${output}"`,
      { stdio: "pipe" }
    );
    cleanup(videoFile, musicFile);
    sendFile(res, output, "video-with-music.mp4", "video/mp4");
  } catch (err) {
    cleanup(videoFile, musicFile, output);
    ffmpegError(res, err, "video/mix-music");
  }
});

// POST /video/probe
app.post("/video/probe", upload.single("video"), async (req, res) => {
  let input;
  try {
    const url = req.body?.video_url || req.body?.url;
    if (url) {
      input = tmpFile(".mp4");
      await fetchUrl(url, input);
    } else {
      ({ localPath: input } = await resolveInput(req, "video"));
    }
    const result = execSync(`ffprobe -v quiet -print_format json -show_streams -show_format "${input}"`, { stdio: "pipe" });
    cleanup(input);
    res.json(JSON.parse(result.toString()));
  } catch (err) {
    cleanup(input);
    ffmpegError(res, err, "video/probe");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// IMAGE
// ═════════════════════════════════════════════════════════════════════════════

// POST /image/to-video
// Body: { image_url, duration_s, fps, width, height }
app.post("/image/to-video", upload.single("image"), async (req, res) => {
  let imageFile, output;
  try {
    const url      = req.body?.image_url || req.body?.url;
    const duration = parseFloat(req.body?.duration_s ?? "5");
    const fps      = parseInt(req.body?.fps           ?? "25", 10);
    const width    = parseInt(req.body?.width         ?? "1920", 10);
    const height   = parseInt(req.body?.height        ?? "1080", 10);

    imageFile = tmpFile(".jpg");
    output    = tmpFile(".mp4");

    if (url) await fetchUrl(url, imageFile);
    else { const f = req.file; if (f) fs.copyFileSync(f.path, imageFile); else throw new Error("No image input"); }

    execSync(
      `ffmpeg -y -loop 1 -i "${imageFile}" -t ${duration} -r ${fps} ` +
      `-vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2" ` +
      `-c:v libx264 -pix_fmt yuv420p "${output}"`,
      { stdio: "pipe" }
    );
    cleanup(imageFile);
    sendFile(res, output, "image-clip.mp4", "video/mp4");
  } catch (err) {
    cleanup(imageFile, output);
    ffmpegError(res, err, "image/to-video");
  }
});

// POST /image/zoom
// Ken Burns effect — slow zoom and/or pan on a still image
// Body: { image_url, duration_s, fps, zoom_direction, zoom_from, zoom_to, width, height }
// zoom_direction: "in" (default) | "out" | "left" | "right" | "in-left" | "in-right"
app.post("/image/zoom", upload.single("image"), async (req, res) => {
  let imageFile, output;
  try {
    const url       = req.body?.image_url || req.body?.url;
    const duration  = parseFloat(req.body?.duration_s ?? "5");
    const fps       = parseInt(req.body?.fps           ?? "25", 10);
    const direction = req.body?.zoom_direction         ?? "in";
    const zoomFrom  = parseFloat(req.body?.zoom_from   ?? "1.0");
    const zoomTo    = parseFloat(req.body?.zoom_to     ?? "1.05");
    // width/height: auto-detected from image below. Override by passing width/height in body.

    imageFile = tmpFile(".jpg");
    output    = tmpFile(".mp4");

    if (url) await fetchUrl(url, imageFile);
    else { const f = req.file; if (f) fs.copyFileSync(f.path, imageFile); else throw new Error("No image input"); }

    // Detect input dimensions to preserve orientation
    // If caller explicitly set width/height use those, otherwise derive from image
    let outW = req.body?.width  ? parseInt(req.body.width,  10) : null;
    let outH = req.body?.height ? parseInt(req.body.height, 10) : null;

    if (!outW || !outH) {
      const probe    = JSON.parse(execSync(`ffprobe -v quiet -print_format json -show_streams "${imageFile}"`, { stdio: "pipe" }).toString());
      const stream   = probe.streams.find(s => s.codec_type === "video") || probe.streams[0];
      const imgW     = stream.width;
      const imgH     = stream.height;
      const portrait = imgH > imgW;

      if (portrait) {
        // Portrait: default to 1080x1920, respect explicit overrides
        outW = outW ?? 1080;
        outH = outH ?? 1920;
      } else {
        // Landscape / square: default to 1920x1080
        outW = outW ?? 1920;
        outH = outH ?? 1080;
      }
    }

    // Ensure both dimensions are divisible by 2 (libx264 requirement)
    outW = outW % 2 === 0 ? outW : outW + 1;
    outH = outH % 2 === 0 ? outH : outH + 1;

    const totalFrames = Math.ceil(duration * fps);

    // Build zoompan filter based on direction
    let zoomExpr, xExpr, yExpr;
    const zoomStep = (zoomTo - zoomFrom) / totalFrames;

    switch (direction) {
      case "out":
        zoomExpr = `zoom='${zoomTo}-${zoomStep.toFixed(6)}*on'`;
        xExpr    = "x='iw/2-(iw/zoom/2)'";
        yExpr    = "y='ih/2-(ih/zoom/2)'";
        break;
      case "left":
        zoomExpr = `zoom=${zoomFrom}`;
        xExpr    = `x='iw/zoom/2+on*(iw/zoom/${totalFrames})'`;
        yExpr    = "y='ih/2-(ih/zoom/2)'";
        break;
      case "right":
        zoomExpr = `zoom=${zoomFrom}`;
        xExpr    = `x='iw/zoom/2-on*(iw/zoom/${totalFrames})'`;
        yExpr    = "y='ih/2-(ih/zoom/2)'";
        break;
      case "in-left":
        zoomExpr = `zoom='${zoomFrom}+${zoomStep.toFixed(6)}*on'`;
        xExpr    = `x='iw/2-(iw/zoom/2)+(on*(iw/zoom/${totalFrames}*0.3))'`;
        yExpr    = "y='ih/2-(ih/zoom/2)'";
        break;
      case "in-right":
        zoomExpr = `zoom='${zoomFrom}+${zoomStep.toFixed(6)}*on'`;
        xExpr    = `x='iw/2-(iw/zoom/2)-(on*(iw/zoom/${totalFrames}*0.3))'`;
        yExpr    = "y='ih/2-(ih/zoom/2)'";
        break;
      case "in":
      default:
        zoomExpr = `zoom='${zoomFrom}+${zoomStep.toFixed(6)}*on'`;
        xExpr    = "x='iw/2-(iw/zoom/2)'";
        yExpr    = "y='ih/2-(ih/zoom/2)'";
        break;
    }

    // zoompan outputs at outW x outH, then scale+pad ensures exact dimensions
    const zoompan  = `zoompan=${zoomExpr}:${xExpr}:${yExpr}:d=${totalFrames}:s=${outW}x${outH}:fps=${fps}`;
    const scalepad = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=black`;

    execSync(
      `ffmpeg -y -loop 1 -i "${imageFile}" -t ${duration} ` +
      `-vf "${zoompan},${scalepad}" ` +
      `-c:v libx264 -pix_fmt yuv420p "${output}"`,
      { stdio: "pipe" }
    );
    cleanup(imageFile);
    sendFile(res, output, "zoom.mp4", "video/mp4");
  } catch (err) {
    cleanup(imageFile, output);
    ffmpegError(res, err, "image/zoom");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// RENDER
// ═════════════════════════════════════════════════════════════════════════════

// POST /render/episode
// Full pipeline: ordered visual clips (image or video) + audio track → assembled video
// Body: {
//   clips: [ { url, type: "image"|"video", duration_s (images only), zoom_direction } ],
//   audio_url,
//   music_url,        optional
//   music_volume,     default 0.08
//   loop_music,       default true
//   width, height, fps
// }
app.post("/render/episode", async (req, res) => {
  const temps     = [];
  const clipFiles = [];
  let listFile, videoOnly, withAudio, output;

  try {
    const {
      clips, audio_url, music_url, music_volume = 0.08,
      loop_music = true, width = 1920, height = 1080, fps = 25
    } = req.body;

    if (!clips || !Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "Requires clips array" });
    }
    if (!audio_url) return res.status(400).json({ error: "Requires audio_url" });

    // 1. Render each clip to a tmp video file
    for (const clip of clips) {
      const ext     = path.extname(new URL(clip.url).pathname) || ".tmp";
      const srcFile = tmpFile(ext);
      await fetchUrl(clip.url, srcFile);
      temps.push(srcFile);

      const clipOut = tmpFile(".mp4");
      clipFiles.push(clipOut);

      if (clip.type === "video") {
        // Re-encode to uniform codec/resolution
        execSync(
          `ffmpeg -y -i "${srcFile}" -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2" ` +
          `-c:v libx264 -pix_fmt yuv420p -an "${clipOut}"`,
          { stdio: "pipe" }
        );
      } else {
        // image — Ken Burns if zoom_direction specified, else static
        const duration = parseFloat(clip.duration_s ?? "5");
        const direction = clip.zoom_direction;

        if (direction) {
          const totalFrames = Math.ceil(duration * fps);
          const zoomFrom = 1.0, zoomTo = 1.05;
          const zoomStep = (zoomTo - zoomFrom) / totalFrames;
          const zoomExpr = `zoom='${zoomFrom}+${zoomStep.toFixed(6)}*on'`;
          const zoompan  = `zoompan=${zoomExpr}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
          execSync(
            `ffmpeg -y -loop 1 -i "${srcFile}" -t ${duration} ` +
            `-vf "${zoompan},scale=${width}:${height}" ` +
            `-c:v libx264 -pix_fmt yuv420p "${clipOut}"`,
            { stdio: "pipe" }
          );
        } else {
          execSync(
            `ffmpeg -y -loop 1 -i "${srcFile}" -t ${duration} -r ${fps} ` +
            `-vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2" ` +
            `-c:v libx264 -pix_fmt yuv420p "${clipOut}"`,
            { stdio: "pipe" }
          );
        }
      }
    }

    // 2. Concat all clips into one video (no audio yet)
    listFile  = tmpFile(".txt");
    videoOnly = tmpFile(".mp4");
    fs.writeFileSync(listFile, clipFiles.map(f => `file '${f}'`).join("\n"));
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${videoOnly}"`, { stdio: "pipe" });
    cleanup(listFile);
    cleanupAll(temps);
    cleanupAll(clipFiles);

    // 3. Fetch and attach audio
    const audioFile = tmpFile(".mp3");
    await fetchUrl(audio_url, audioFile);
    withAudio = tmpFile(".mp4");

    execSync(
      `ffmpeg -y -i "${videoOnly}" -i "${audioFile}" -map 0:v -map 1:a -c:v copy -shortest "${withAudio}"`,
      { stdio: "pipe" }
    );
    cleanup(videoOnly, audioFile);

    // 4. Optional background music
    let current = withAudio;
    if (music_url) {
      const musicFile = tmpFile(".mp3");
      await fetchUrl(music_url, musicFile);
      output = tmpFile(".mp4");
      const loopFlag = loop_music ? "-stream_loop -1" : "";
      const vol      = parseFloat(music_volume);
      execSync(
        `ffmpeg -y -i "${current}" ${loopFlag} -i "${musicFile}" ` +
        `-filter_complex "[0:a]volume=1.0[speech];[1:a]volume=${vol}[music];[speech][music]amix=inputs=2:duration=first[aout]" ` +
        `-map 0:v -map "[aout]" -c:v copy -c:a aac "${output}"`,
        { stdio: "pipe" }
      );
      cleanup(current, musicFile);
      current = output;
    }

    sendFile(res, current, "episode.mp4", "video/mp4");

  } catch (err) {
    cleanupAll(temps);
    cleanupAll(clipFiles);
    cleanup(listFile, videoOnly, withAudio, output);
    ffmpegError(res, err, "render/episode");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// VIDEO ASSEMBLE + MIX
// ═════════════════════════════════════════════════════════════════════════════

// POST /video/assemble
// Pure visual sequencer — images and videos, per-clip Ken Burns, per-clip
// transitions, chained xfade filter graph. Output is a SILENT video.
// Use /video/mix downstream to add voiceover + music.
//
// Body: {
//   clips: [
//     {
//       url:             string   — source URL
//       type:            "image" | "video"
//       duration_s:      number   — required for images, optional trim for video
//       keep_audio:      bool     — default false (strip audio from video clips)
//       zoom_direction:  string   — images only: "in"|"out"|"left"|"right"|"in-left"|"in-right"
//       zoom_from:       number   — default 1.0
//       zoom_to:         number   — default 1.05
//       trim_start_s:    number   — video only, optional
//       trim_end_s:      number   — video only, optional
//       transition_out:  { type: "fade"|"cut", duration_s: number }
//     }
//   ],
//   width:   number  — default 1920
//   height:  number  — default 1080
//   fps:     number  — default 25
//   speed:   number  — default 1.0; playback speed multiplier applied to final output
// }
app.post("/video/assemble", async (req, res) => {
  const temps     = [];
  const clipFiles = [];
  let output, sped;

  try {
    const { clips, width = 1920, height = 1080, fps = 25 } = req.body;

    if (!clips || !Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "Requires clips array" });
    }

    const speed = parseFloat(req.body?.speed ?? "1.0");
    if (isNaN(speed) || speed <= 0) {
      return res.status(400).json({ error: "speed must be a positive number" });
    }

    const W = parseInt(width,  10) % 2 === 0 ? parseInt(width,  10) : parseInt(width,  10) + 1;
    const H = parseInt(height, 10) % 2 === 0 ? parseInt(height, 10) : parseInt(height, 10) + 1;
    const FPS = parseInt(fps, 10);

    // ── Helper: build zoompan filter string ───────────────────────────────────
    function buildZoompan(clip, totalFrames) {
      const zoomFrom  = parseFloat(clip.zoom_from ?? "1.0");
      const zoomTo    = parseFloat(clip.zoom_to   ?? "1.05");
      const zoomStep  = (zoomTo - zoomFrom) / totalFrames;
      const direction = clip.zoom_direction ?? "in";
      let zoomExpr, xExpr, yExpr;

      switch (direction) {
        case "out":
          zoomExpr = `zoom='${zoomTo}-${zoomStep.toFixed(6)}*on'`;
          xExpr    = "x='iw/2-(iw/zoom/2)'";
          yExpr    = "y='ih/2-(ih/zoom/2)'";
          break;
        case "left":
          zoomExpr = `zoom=${zoomFrom}`;
          xExpr    = `x='iw/zoom/2+on*(iw/zoom/${totalFrames})'`;
          yExpr    = "y='ih/2-(ih/zoom/2)'";
          break;
        case "right":
          zoomExpr = `zoom=${zoomFrom}`;
          xExpr    = `x='iw/zoom/2-on*(iw/zoom/${totalFrames})'`;
          yExpr    = "y='ih/2-(ih/zoom/2)'";
          break;
        case "in-left":
          zoomExpr = `zoom='${zoomFrom}+${zoomStep.toFixed(6)}*on'`;
          xExpr    = `x='iw/2-(iw/zoom/2)+(on*(iw/zoom/${totalFrames}*0.3))'`;
          yExpr    = "y='ih/2-(ih/zoom/2)'";
          break;
        case "in-right":
          zoomExpr = `zoom='${zoomFrom}+${zoomStep.toFixed(6)}*on'`;
          xExpr    = `x='iw/2-(iw/zoom/2)-(on*(iw/zoom/${totalFrames}*0.3))'`;
          yExpr    = "y='ih/2-(ih/zoom/2)'";
          break;
        case "in":
        default:
          zoomExpr = `zoom='${zoomFrom}+${zoomStep.toFixed(6)}*on'`;
          xExpr    = "x='iw/2-(iw/zoom/2)'";
          yExpr    = "y='ih/2-(ih/zoom/2)'";
          break;
      }
      return `zoompan=${zoomExpr}:${xExpr}:${yExpr}:d=${totalFrames}:s=${W}x${H}:fps=${FPS}`;
    }

    const scalepad = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;

    // ── Step 1: Render each clip to a normalised silent MP4 ───────────────────
    for (const clip of clips) {
      const ext     = path.extname(new URL(clip.url).pathname) || ".tmp";
      const srcFile = tmpFile(ext);
      await fetchUrl(clip.url, srcFile);
      temps.push(srcFile);

      const clipOut = tmpFile(".mp4");
      clipFiles.push(clipOut);

      if (clip.type === "video") {
        const keepAudio  = clip.keep_audio === true;
        const audioFlag  = keepAudio ? "" : "-an";
        const startFlag  = clip.trim_start_s != null ? `-ss ${parseFloat(clip.trim_start_s)}` : "";
        const endFlag    = clip.trim_end_s   != null ? `-to ${parseFloat(clip.trim_end_s)}`   : "";
        const durFlag    = clip.duration_s   != null && clip.trim_start_s == null
                            ? `-t ${parseFloat(clip.duration_s)}` : "";

        execSync(
          `ffmpeg -y ${startFlag} -i "${srcFile}" ${endFlag} ${durFlag} ` +
          `-vf "${scalepad}" -c:v libx264 -pix_fmt yuv420p ${audioFlag} "${clipOut}"`,
          { stdio: "pipe" }
        );
      } else {
        // image
        const duration    = parseFloat(clip.duration_s ?? "5");
        const totalFrames = Math.ceil(duration * FPS);

        if (clip.zoom_direction) {
          const zoompan = buildZoompan(clip, totalFrames);
          execSync(
            `ffmpeg -y -loop 1 -i "${srcFile}" -t ${duration} ` +
            `-vf "${zoompan},${scalepad}" ` +
            `-c:v libx264 -pix_fmt yuv420p -an "${clipOut}"`,
            { stdio: "pipe" }
          );
        } else {
          execSync(
            `ffmpeg -y -loop 1 -i "${srcFile}" -t ${duration} -r ${FPS} ` +
            `-vf "${scalepad}" ` +
            `-c:v libx264 -pix_fmt yuv420p -an "${clipOut}"`,
            { stdio: "pipe" }
          );
        }
      }
    }

    cleanupAll(temps);
    output = tmpFile(".mp4");

    // ── Step 2: Stitch clips with xfade filter graph ──────────────────────────
    if (clipFiles.length === 1) {
      // Single clip — just copy it out
      fs.copyFileSync(clipFiles[0], output);
    } else {
      // Probe durations for xfade offset calculation
      const durations = clipFiles.map(f => {
        const probe = JSON.parse(
          execSync(`ffprobe -v quiet -print_format json -show_format "${f}"`, { stdio: "pipe" }).toString()
        );
        return parseFloat(probe.format.duration);
      });

      // Build inputs string and chained xfade filter graph
      // Each clip gets a transition_out — default fade 0.5s unless type is "cut"
      let inputsStr   = clipFiles.map(f => `-i "${f}"`).join(" ");
      let filterParts = [];
      let currentLabel = "[0:v]";
      let timeOffset   = 0;

      for (let i = 0; i < clipFiles.length - 1; i++) {
        const tx       = clips[i]?.transition_out ?? { type: "fade", duration_s: 0.5 };
        const txType   = tx.type ?? "fade";
        const txDur    = parseFloat(tx.duration_s ?? "0.5");
        const nextLabel = i === clipFiles.length - 2 ? "[vout]" : `[v${i + 1}]`;

        timeOffset += durations[i] - (txType === "cut" ? 0 : txDur);

        if (txType === "cut") {
          // For cut: just concat, no xfade
          filterParts.push(`${currentLabel}[${i + 1}:v]concat=n=2:v=1:a=0${nextLabel}`);
        } else {
          filterParts.push(
            `${currentLabel}[${i + 1}:v]xfade=transition=fade:duration=${txDur}:offset=${timeOffset.toFixed(3)}${nextLabel}`
          );
        }
        currentLabel = nextLabel;
      }

      const filterComplex = filterParts.join(";");
      execSync(
        `ffmpeg -y ${inputsStr} -filter_complex "${filterComplex}" -map "[vout]" ` +
        `-c:v libx264 -pix_fmt yuv420p -an "${output}"`,
        { stdio: "pipe" }
      );
    }

    cleanupAll(clipFiles);

    // Optional speed adjustment — setpts=PTS/speed compresses or stretches presentation timestamps
    if (speed !== 1.0) {
      sped = tmpFile(".mp4");
      execSync(
        `ffmpeg -y -i "${output}" -vf "setpts=PTS/${speed}" -r ${FPS} -c:v libx264 -pix_fmt yuv420p -an "${sped}"`,
        { stdio: "pipe" }
      );
      cleanup(output);
      output = sped;
    }

    sendFile(res, output, "assembled.mp4", "video/mp4");

  } catch (err) {
    cleanupAll(temps);
    cleanupAll(clipFiles);
    cleanup(output, sped);
    ffmpegError(res, err, "video/assemble");
  }
});

// POST /video/mix
// Takes a silent (or any) video and layers voiceover + background music.
// All audio inputs are optional — use any combination.
//
// Body: {
//   video_url:         string  — required
//   voiceover_url:     string  — optional
//   voiceover_volume:  number  — default 1.0
//   music_url:         string  — optional
//   music_volume:      number  — default 0.08
//   loop_music:        bool    — default true
//   replace_original:  bool    — default true (strip any existing audio on input video)
// }
app.post("/video/mix", async (req, res) => {
  let videoFile, voiceFile, musicFile, output;
  try {
    const {
      video_url,
      voiceover_url,
      voiceover_volume = 1.0,
      music_url,
      music_volume     = 0.08,
      loop_music       = true,
      replace_original = true
    } = req.body;

    if (!video_url) return res.status(400).json({ error: "Requires video_url" });
    if (!voiceover_url && !music_url) {
      return res.status(400).json({ error: "Requires at least one of: voiceover_url, music_url" });
    }

    videoFile = tmpFile(".mp4");
    output    = tmpFile(".mp4");
    await fetchUrl(video_url, videoFile);

    const vVol  = parseFloat(voiceover_volume);
    const mVol  = parseFloat(music_volume);
    const loop  = loop_music ? "-stream_loop -1" : "";

    // Build filter_complex dynamically based on which audio sources are present
    // Input 0 is always the video
    // Input 1+ are audio sources in order: voiceover, music

    if (voiceover_url && music_url) {
      // Both voiceover and music
      voiceFile = tmpFile(".mp3");
      musicFile = tmpFile(".mp3");
      await fetchUrl(voiceover_url, voiceFile);
      await fetchUrl(music_url, musicFile);

      const videoAudioInput = replace_original ? "" : `[0:a]volume=1.0[origaudio];`;
      const mixInputs       = replace_original
        ? `[1:a]volume=${vVol}[vo];[2:a]volume=${mVol}[mu];[vo][mu]amix=inputs=2:duration=first[aout]`
        : `[1:a]volume=${vVol}[vo];[2:a]volume=${mVol}[mu];[origaudio][vo][mu]amix=inputs=3:duration=first[aout]`;

      execSync(
        `ffmpeg -y -i "${videoFile}" -i "${voiceFile}" ${loop} -vn -i "${musicFile}" ` +
        `-filter_complex "${videoAudioInput}${mixInputs}" ` +
        `-map 0:v -map "[aout]" -c:v copy -c:a aac "${output}"`,
        { stdio: "pipe" }
      );

    } else if (voiceover_url) {
      // Voiceover only
      voiceFile = tmpFile(".mp3");
      await fetchUrl(voiceover_url, voiceFile);

      if (replace_original) {
        execSync(
          `ffmpeg -y -i "${videoFile}" -i "${voiceFile}" ` +
          `-filter_complex "[1:a]volume=${vVol}[aout]" ` +
          `-map 0:v -map "[aout]" -c:v copy -c:a aac "${output}"`,
          { stdio: "pipe" }
        );
      } else {
        execSync(
          `ffmpeg -y -i "${videoFile}" -i "${voiceFile}" ` +
          `-filter_complex "[0:a]volume=1.0[orig];[1:a]volume=${vVol}[vo];[orig][vo]amix=inputs=2:duration=first[aout]" ` +
          `-map 0:v -map "[aout]" -c:v copy -c:a aac "${output}"`,
          { stdio: "pipe" }
        );
      }

    } else {
      // Music only
      musicFile = tmpFile(".mp3");
      await fetchUrl(music_url, musicFile);

      if (replace_original) {
        execSync(
          `ffmpeg -y -i "${videoFile}" ${loop} -vn -i "${musicFile}" ` +
          `-filter_complex "[1:a]volume=${mVol}[aout]" ` +
          `-map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${output}"`,
          { stdio: "pipe" }
        );
      } else {
        execSync(
          `ffmpeg -y -i "${videoFile}" ${loop} -vn -i "${musicFile}" ` +
          `-filter_complex "[0:a]volume=1.0[orig];[1:a]volume=${mVol}[mu];[orig][mu]amix=inputs=2:duration=first[aout]" ` +
          `-map 0:v -map "[aout]" -c:v copy -c:a aac "${output}"`,
          { stdio: "pipe" }
        );
      }
    }

    cleanup(videoFile, voiceFile, musicFile);
    sendFile(res, output, "mixed.mp4", "video/mp4");

  } catch (err) {
    cleanup(videoFile, voiceFile, musicFile, output);
    ffmpegError(res, err, "video/mix");
  }
});

// POST /render/probe — probe any file type
app.post("/render/probe", upload.single("file"), async (req, res) => {
  let input;
  try {
    const url = req.body?.url;
    if (url) {
      const ext = path.extname(new URL(url).pathname) || ".tmp";
      input = tmpFile(ext);
      await fetchUrl(url, input);
    } else {
      ({ localPath: input } = await resolveInput(req, "file"));
    }
    const result = execSync(`ffprobe -v quiet -print_format json -show_streams -show_format "${input}"`, { stdio: "pipe" });
    cleanup(input);
    res.json(JSON.parse(result.toString()));
  } catch (err) {
    cleanup(input);
    ffmpegError(res, err, "render/probe");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// UTIL — gnh1201/ffmpeg-api compatibility layer
// ═════════════════════════════════════════════════════════════════════════════

function convertRoute(outputExt, outputMime) {
  return [upload.single("file"), async (req, res) => {
    let input, output;
    try {
      ({ localPath: input } = await resolveInput(req, "file"));
      output = tmpFile(outputExt);
      execSync(`ffmpeg -y -i "${input}" "${output}"`, { stdio: "pipe" });
      cleanup(input);
      sendFile(res, output, `converted${outputExt}`, outputMime);
    } catch (err) {
      cleanup(input, output);
      ffmpegError(res, err, `convert${outputExt}`);
    }
  }];
}

app.post("/convert/audio/to/mp3",  ...convertRoute(".mp3", "audio/mpeg"));
app.post("/convert/audio/to/wav",  ...convertRoute(".wav", "audio/wav"));
app.post("/convert/video/to/mp4",  ...convertRoute(".mp4", "video/mp4"));
app.post("/convert/image/to/jpg",  ...convertRoute(".jpg", "image/jpeg"));

app.post("/video/extract/audio", upload.single("file"), async (req, res) => {
  let input, output;
  try {
    ({ localPath: input } = await resolveInput(req, "file"));
    output = tmpFile(".mp3");
    execSync(`ffmpeg -y -i "${input}" -vn -c:a libmp3lame -q:a 2 "${output}"`, { stdio: "pipe" });
    cleanup(input);
    sendFile(res, output, "extracted-audio.mp3", "audio/mpeg");
  } catch (err) {
    cleanup(input, output);
    ffmpegError(res, err, "video/extract/audio");
  }
});

app.post("/video/extract/images", upload.single("file"), async (req, res) => {
  let input;
  const frameFiles = [];
  try {
    ({ localPath: input } = await resolveInput(req, "file"));
    const fps    = req.body?.fps ?? "1";
    const outDir = path.join(os.tmpdir(), `frames_${Date.now()}`);
    fs.mkdirSync(outDir);
    execSync(`ffmpeg -y -i "${input}" -vf "fps=${fps}" "${outDir}/frame_%04d.jpg"`, { stdio: "pipe" });
    cleanup(input);

    const frames = fs.readdirSync(outDir).sort();
    const results = frames.map(f => {
      const data = fs.readFileSync(path.join(outDir, f));
      return { filename: f, base64: data.toString("base64"), mime: "image/jpeg" };
    });

    frames.forEach(f => cleanup(path.join(outDir, f)));
    try { fs.rmdirSync(outDir); } catch (_) {}

    res.json({ frames: results });
  } catch (err) {
    cleanup(input);
    ffmpegError(res, err, "video/extract/images");
  }
});

// gnh1201 compat: /probe
app.post("/probe", upload.single("file"), async (req, res) => {
  let input;
  try {
    ({ localPath: input } = await resolveInput(req, "file"));
    const result = execSync(`ffprobe -v quiet -print_format json -show_streams -show_format "${input}"`, { stdio: "pipe" });
    cleanup(input);
    res.json(JSON.parse(result.toString()));
  } catch (err) {
    cleanup(input);
    ffmpegError(res, err, "probe");
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`ffmpeg-media-api running on port ${PORT}`);
  console.log(`GET http://localhost:${PORT}/ for endpoint listing`);
});
