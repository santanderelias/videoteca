const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const videoId = process.argv[2] || 'example-movie';
const timeout = AbortSignal.timeout(15000);

const healthResponse = await fetch(`${baseUrl}/api/health`, { signal: timeout });
if (!healthResponse.ok || (await healthResponse.json()).status !== 'ok') {
  throw new Error('The server health check failed.');
}

const catalogResponse = await fetch(`${baseUrl}/api/videos`, { signal: timeout });
if (!catalogResponse.ok) throw new Error('The catalog endpoint failed.');
const catalog = await catalogResponse.json();
if (!catalog.some((video) => video.id === videoId)) {
  throw new Error(`Video id "${videoId}" is not present in videos.json.`);
}

const streamResponse = await fetch(`${baseUrl}/api/videos/${encodeURIComponent(videoId)}/stream`, { signal: timeout });
if (!streamResponse.ok) {
  const detail = await streamResponse.text();
  throw new Error(`Stream request failed (${streamResponse.status}): ${detail}`);
}

const reader = streamResponse.body.getReader();
let data = Buffer.alloc(0);
while (data.length < 65536) {
  const { done, value } = await reader.read();
  if (done) break;
  data = Buffer.concat([data, value]);
  if (data.includes(Buffer.from('ftyp'))) break;
}
await reader.cancel();

if (!data.includes(Buffer.from('ftyp'))) {
  throw new Error('The stream did not contain an MP4 file header.');
}

console.log(`Stream probe passed for "${videoId}" (${data.length} bytes received).`);
console.log(`Open ${baseUrl} on a phone connected to the same network and play this title.`);