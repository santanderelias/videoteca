import { spawn, execSync } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(appRoot, 'tmp-test-subtitles');
const testMediaRoot = path.join(testDir, 'src');
const testVideosFile = path.join(testDir, 'videos.json');
const testPort = 3099;

async function runTest() {
  console.log('Starting embedded subtitles test...');

  await rm(testDir, { recursive: true, force: true });
  await mkdir(testMediaRoot, { recursive: true });

  const dummySrt = path.join(testDir, 'dummy.srt');
  await writeFile(dummySrt, '1\n00:00:00,500 --> 00:00:03,500\nHello embedded subtitle test!\n', 'utf8');

  const testMkv = path.join(testMediaRoot, 'sample.mkv');
  console.log('Generating test MKV file with embedded subtitles via FFmpeg...');
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=1 -i "${dummySrt}" -c:v libx264 -c:s srt -metadata:s:s:0 language=eng -metadata:s:s:0 title="English Embedded Test" "${testMkv}"`,
    { stdio: 'inherit' }
  );

  console.log('Running catalog generator (generate-videos.js)...');
  execSync(`node scripts/generate-videos.js`, {
    env: {
      ...process.env,
      MEDIA_ROOT: testMediaRoot,
      VIDEOS_FILE: testVideosFile,
    },
    stdio: 'inherit',
  });

  const catalogRaw = await readFile(testVideosFile, 'utf8');
  const catalog = JSON.parse(catalogRaw);
  console.log('Generated catalog:', JSON.stringify(catalog, null, 2));

  if (!Array.isArray(catalog) || catalog.length !== 1) {
    throw new Error('Expected catalog to contain 1 video.');
  }

  const item = catalog[0];
  if (!Array.isArray(item.subtitles) || item.subtitles.length !== 1) {
    throw new Error(`Expected 1 subtitle entry in catalog, got ${item.subtitles?.length}`);
  }

  const sub = item.subtitles[0];
  if (sub.label !== 'English Embedded Test' || sub.lang !== 'eng' || typeof sub.streamIndex !== 'number') {
    throw new Error(`Unexpected subtitle metadata: ${JSON.stringify(sub)}`);
  }
  console.log('Catalog validation passed!');

  console.log(`Starting media server on port ${testPort}...`);
  const serverProcess = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(testPort),
      HOST: '127.0.0.1',
      MEDIA_ROOT: testMediaRoot,
      VIDEOS_FILE: testVideosFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  serverProcess.stdout.on('data', (d) => { serverOutput += d; });
  serverProcess.stderr.on('data', (d) => { serverOutput += d; });

  try {
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = setInterval(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${testPort}/api/health`);
          if (res.ok) {
            clearInterval(check);
            resolve();
          }
        } catch {
          if (Date.now() - start > 5000) {
            clearInterval(check);
            reject(new Error(`Server failed to start. Output: ${serverOutput}`));
          }
        }
      }, 100);
    });

    console.log('Server health check passed!');

    const videosRes = await fetch(`http://127.0.0.1:${testPort}/api/videos`);
    if (!videosRes.ok) throw new Error(`/api/videos returned ${videosRes.status}`);
    const videos = await videosRes.json();
    if (!Array.isArray(videos) || videos.length !== 1 || !videos[0].subtitles.length) {
      throw new Error(`Unexpected /api/videos response: ${JSON.stringify(videos)}`);
    }

    const subTrack = videos[0].subtitles[0];
    console.log('Fetched video subtitle track route:', subTrack.src);

    const subRes = await fetch(`http://127.0.0.1:${testPort}${subTrack.src}`);
    if (!subRes.ok) throw new Error(`Subtitle route returned ${subRes.status}`);
    const contentType = subRes.headers.get('content-type');
    if (!contentType || !contentType.includes('text/vtt')) {
      throw new Error(`Expected text/vtt content-type, got ${contentType}`);
    }

    const subText = await subRes.text();
    console.log('Subtitle VTT content:\n' + subText);

    if (!subText.includes('WEBVTT') || !subText.includes('Hello embedded subtitle test!')) {
      throw new Error('Subtitle VTT content missing expected WebVTT header or body text.');
    }

    console.log('All subtitle extraction and streaming tests PASSED successfully!');
  } finally {
    serverProcess.kill('SIGTERM');
    await rm(testDir, { recursive: true, force: true });
  }
}

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
