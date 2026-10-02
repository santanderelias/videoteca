import express from 'express';
import { spawn } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(appRoot, 'public');
const mediaRoot = path.resolve(process.env.MEDIA_ROOT || path.join(appRoot, 'src'));
const videosFile = path.resolve(process.env.VIDEOS_FILE || path.join(appRoot, 'videos.json'));
const host = process.env.HOST || '0.0.0.0';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const durationCache = new Map();

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveConfiguredPath(relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error('Media paths must be relative to MEDIA_ROOT.');
  }

  const resolved = path.resolve(mediaRoot, relativePath);
  if (!isWithin(mediaRoot, resolved)) {
    throw new Error('Media path escapes MEDIA_ROOT.');
  }
  return resolved;
}

function validateCatalog(items) {
  if (!Array.isArray(items)) {
    throw new Error('videos.json must contain an array.');
  }

  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(item.id)) {
      throw new Error('Each video needs a simple, unique id.');
    }
    if (ids.has(item.id)) {
      throw new Error(`Duplicate video id: ${item.id}`);
    }
    ids.add(item.id);

    if (typeof item.title !== 'string' || !item.title.trim() || typeof item.category !== 'string' || !item.category.trim()) {
      throw new Error(`Video ${item.id} needs a title and category.`);
    }
    resolveConfiguredPath(item.file_path);
    if (item.subtitles !== undefined && !Array.isArray(item.subtitles)) {
      throw new Error(`Subtitles for ${item.id} must be an array.`);
    }
    for (const subtitle of item.subtitles || []) {
      if (typeof subtitle.label !== 'string' || typeof subtitle.lang !== 'string') {
        throw new Error(`Subtitle entries for ${item.id} need label and lang values.`);
      }
      resolveConfiguredPath(subtitle.src);
    }
  }
  return items;
}

async function getMediaFile(relativePath) {
  const resolved = resolveConfiguredPath(relativePath);
  const [mediaRootReal, fileReal] = await Promise.all([realpath(mediaRoot), realpath(resolved)]);
  if (!isWithin(mediaRootReal, fileReal)) {
    throw new Error('Media path resolves outside MEDIA_ROOT.');
  }
  await access(fileReal);
  return fileReal;
}

async function loadCatalog() {
  const contents = await readFile(videosFile, 'utf8');
  return validateCatalog(JSON.parse(contents));
}

const app = express();
app.disable('x-powered-by');

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/videos', async (_request, response, next) => {
  try {
    const videos = await loadCatalog();
    const orderedVideos = videos.sort((left, right) => left.file_path.localeCompare(
      right.file_path,
      undefined,
      { numeric: true, sensitivity: 'base' },
    ));
    response.json(orderedVideos.map((video) => ({
      id: video.id,
      title: video.title,
      category: video.category,
      file_path: video.file_path,
      subtitles: (video.subtitles || []).map((subtitle, index) => ({
        label: subtitle.label,
        lang: subtitle.lang,
        src: `/api/videos/${encodeURIComponent(video.id)}/subtitles/${index}`,
      })),
      info: `/api/videos/${encodeURIComponent(video.id)}/info`,
      audio: `/api/videos/${encodeURIComponent(video.id)}/audio`,
      stream: `/api/videos/${encodeURIComponent(video.id)}/stream`,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/subtitles/:index', async (request, response, next) => {
  try {
    const videos = await loadCatalog();
    const video = videos.find((entry) => entry.id === request.params.id);
    const index = Number.parseInt(request.params.index, 10);
    const subtitle = Number.isInteger(index) && index >= 0 ? video?.subtitles?.[index] : null;
    if (!subtitle) {
      response.sendStatus(404);
      return;
    }

    const file = await getMediaFile(subtitle.src);
    response.type('text/vtt').set('Cache-Control', 'no-store').sendFile(file);
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id/info', async (request, response, next) => {
  try {
    const videos = await loadCatalog();
    const video = videos.find((entry) => entry.id === request.params.id);
    if (!video) {
      response.sendStatus(404);
      return;
    }

    const file = await getMediaFile(video.file_path);
    if (!durationCache.has(file)) {
      durationCache.set(file, new Promise((resolve, reject) => {
        const ffprobe = spawn(process.env.FFPROBE_PATH || 'ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', file,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let errorOutput = '';
        ffprobe.stdout.setEncoding('utf8');
        ffprobe.stderr.setEncoding('utf8');
        ffprobe.stdout.on('data', (chunk) => { output += chunk; });
        ffprobe.stderr.on('data', (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-2048); });
        ffprobe.on('error', reject);
        ffprobe.on('close', (code) => {
          const duration = Number.parseFloat(output.trim());
          if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
          else reject(new Error(`FFprobe could not read video duration: ${errorOutput.trim()}`));
        });
      }));
    }
    const duration = await durationCache.get(file);
    response.set('Cache-Control', 'private, max-age=3600').json({ duration });
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.status(404).json({ error: 'Configured media file was not found.' });
      return;
    }
    next(error);
  }
});

app.get('/api/videos/:id/stream', async (request, response, next) => {
  try {
    const videos = await loadCatalog();
    const video = videos.find((entry) => entry.id === request.params.id);
    if (!video) {
      response.sendStatus(404);
      return;
    }

    const startSeconds = Number.parseFloat(request.query.start || '0');
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 604800) {
      response.status(400).json({ error: 'Stream start time must be between 0 and 604800 seconds.' });
      return;
    }

    const inputFile = await getMediaFile(video.file_path);
    const ffmpegArgs = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
    ];
    if (startSeconds > 0) ffmpegArgs.push('-ss', String(startSeconds));
    const videoOptions = startSeconds > 0
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '20', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'copy'];
    ffmpegArgs.push(
      '-i', inputFile,
      '-map', '0:v:0', '-map', '0:a:0?',
      ...videoOptions, '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-sn', '-dn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    );
    const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });

    response.status(200).type('video/mp4').set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    ffmpeg.on('error', (error) => {
      if (!response.headersSent) {
        response.status(500).json({ error: 'Unable to start FFmpeg. Install ffmpeg and ensure it is on PATH.' });
      } else {
        response.destroy(error);
      }
    });
    ffmpeg.on('close', (code) => {
      if (code !== 0 && !response.destroyed) {
        const error = new Error(`FFmpeg exited with code ${code}: ${stderr.trim()}`);
        if (!response.headersSent) {
          response.status(500).json({ error: 'FFmpeg could not read or remux this video.' });
        } else {
          response.destroy(error);
        }
      }
    });
    response.on('close', () => {
      if (!response.writableEnded && ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGTERM');
      }
    });
    ffmpeg.stdout.pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.status(404).json({ error: 'Configured media file was not found.' });
      return;
    }
    next(error);
  }
});

app.get('/api/videos/:id/audio', async (request, response, next) => {
  try {
    const videos = await loadCatalog();
    const video = videos.find((entry) => entry.id === request.params.id);
    if (!video) {
      response.sendStatus(404);
      return;
    }

    const startSeconds = Number.parseFloat(request.query.start || '0');
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 604800) {
      response.status(400).json({ error: 'Audio start time must be between 0 and 604800 seconds.' });
      return;
    }

    const inputFile = await getMediaFile(video.file_path);
    const ffmpegArgs = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
    if (startSeconds > 0) ffmpegArgs.push('-ss', String(startSeconds));
    ffmpegArgs.push(
      '-i', inputFile,
      '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '2', '-ar', '44100',
      '-f', 'mp3', 'pipe:1',
    );
    const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });

    response.status(200).type('audio/mpeg').set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    ffmpeg.on('error', (error) => {
      if (!response.headersSent) response.status(500).json({ error: 'Unable to start FFmpeg audio output.' });
      else response.destroy(error);
    });
    ffmpeg.on('close', (code) => {
      if (code !== 0 && !response.destroyed) {
        const error = new Error(`FFmpeg audio output exited with code ${code}: ${stderr.trim()}`);
        if (!response.headersSent) response.status(500).json({ error: 'FFmpeg could not read audio from this video.' });
        else response.destroy(error);
      }
    });
    response.on('close', () => {
      if (!response.writableEnded && ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM');
    });
    ffmpeg.stdout.pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.status(404).json({ error: 'Configured media file was not found.' });
      return;
    }
    next(error);
  }
});

app.use(express.static(publicRoot, { extensions: ['html'] }));
app.use((error, _request, response, _next) => {
  console.error(error);
  if (!response.headersSent) {
    response.status(500).json({ error: 'The server could not load the catalog or media file.' });
  }
});

try {
  await access(mediaRoot);
} catch {
  console.warn(`Media directory does not exist yet: ${mediaRoot}`);
}

app.listen(port, host, () => {
  console.log(`VideoTeca listening on http://${host}:${port}`);
  console.log(`Catalog: ${videosFile}`);
  console.log(`Media root: ${mediaRoot}`);
});