import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mediaRoot = path.resolve(process.env.MEDIA_ROOT || path.join(projectRoot, 'src'));
const scanRoot = path.resolve(process.argv[2] || process.env.VIDEO_SCAN_DIR || mediaRoot);
const videosFile = path.resolve(process.env.VIDEOS_FILE || path.join(projectRoot, 'videos.json'));
const videoExtensions = new Set([
  '.3gp', '.avi', '.flv', '.m2ts', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg',
  '.mts', '.ogv', '.ts', '.vob', '.webm', '.wmv',
]);
const categoryDirectories = new Set(['anime', 'film', 'films', 'movie', 'movies', 'series', 'show', 'shows', 'tv', 'tv shows']);

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizedName(name) {
  return name.trim().toLocaleLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
}

function seasonNumber(name) {
  const match = name.match(/^(?:season|series|s)[\s._-]*(\d{1,3})$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function episodeMarker(name) {
  const match = name.match(/(?:^|[\s._-])S(\d{1,2})[\s._-]*E(\d{1,3})(?=$|[\s._-])/i)
    || name.match(/(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?=$|[\s._-])/i);
  if (!match) return null;

  const marker = match[0].trim();
  return {
    season: Number.parseInt(match[1], 10),
    episode: Number.parseInt(match[2], 10),
    title: name.replace(match[0], ' ').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim(),
    marker,
  };
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  }));
  return nested.flat();
}

function catalogDetails(filePath) {
  const relativeToScan = path.relative(scanRoot, filePath);
  const relativeParts = relativeToScan.split(path.sep);
  const filename = path.basename(filePath, path.extname(filePath));
  const directories = relativeParts.slice(0, -1);
  const seasonIndex = directories.findIndex((directory) => seasonNumber(directory) !== null);
  const marker = episodeMarker(filename);
  const isSeries = seasonIndex >= 0 || marker !== null;

  if (isSeries) {
    const seriesDirectories = (seasonIndex >= 0 ? directories.slice(0, seasonIndex) : directories)
      .filter((directory) => !categoryDirectories.has(normalizedName(directory)));
    const seriesTitle = seriesDirectories.at(-1) || 'Series';
    const season = marker?.season ?? (seasonIndex >= 0 ? seasonNumber(directories[seasonIndex]) : null);
    const episode = marker?.episode;
    const episodeName = marker ? marker.title : filename.replace(/[._-]+/g, ' ').trim();
    const episodeNumber = episode === undefined ? '' : `E${String(episode).padStart(2, '0')}`;
    const seasonNumberText = season === null ? '' : `S${String(season).padStart(2, '0')}`;
    const episodeCode = `${seasonNumberText}${episodeNumber}`;
    const title = [seriesTitle, episodeCode, episodeName].filter(Boolean).join(' - ');
    return { title, category: 'Series' };
  }

  const movieDirectory = directories.find((directory) => !categoryDirectories.has(normalizedName(directory)));
  return {
    title: movieDirectory || filename.replace(/[._-]+/g, ' ').trim(),
    category: 'Movies',
  };
}

function makeId(relativePath, usedIds) {
  const base = relativePath
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.[^.]+$/, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'video';
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) id = `${base}-${suffix++}`;
  usedIds.add(id);
  return id;
}

function subtitleLanguage(filename, videoBase) {
  const remainder = filename.slice(videoBase.length).replace(/\.vtt$/i, '').replace(/^\./, '');
  if (!remainder) return { label: 'Subtitles', lang: 'und' };
  const language = remainder.match(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)?.[0];
  if (!language) return { label: remainder.replace(/[._-]+/g, ' '), lang: 'und' };

  const displayLanguage = new Intl.DisplayNames(['en'], { type: 'language' }).of(language);
  return { label: displayLanguage || language, lang: language };
}

function findSubtitles(videoPath, allFiles) {
  const folder = path.dirname(videoPath);
  const videoBase = path.basename(videoPath, path.extname(videoPath));
  return allFiles
    .filter((candidate) => path.dirname(candidate) === folder && path.extname(candidate).toLocaleLowerCase() === '.vtt')
    .filter((candidate) => {
      const subtitleBase = path.basename(candidate, path.extname(candidate));
      return subtitleBase === videoBase || subtitleBase.startsWith(`${videoBase}.`);
    })
    .sort((left, right) => left.localeCompare(right))
    .map((subtitlePath) => ({
      ...subtitleLanguage(path.basename(subtitlePath, path.extname(subtitlePath)), videoBase),
      src: path.relative(mediaRoot, subtitlePath).split(path.sep).join('/'),
    }));
}

async function main() {
  if (!isWithin(mediaRoot, scanRoot)) {
    throw new Error('The scan folder must be inside MEDIA_ROOT so generated paths can be streamed safely.');
  }

  const allFiles = await collectFiles(scanRoot);
  const videoFiles = allFiles
    .filter((filePath) => videoExtensions.has(path.extname(filePath).toLocaleLowerCase()))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));

  if (!videoFiles.length) {
    throw new Error(`No video files found under ${scanRoot}; videos.json was not changed.`);
  }

  const usedIds = new Set();
  const catalog = videoFiles.map((filePath) => {
    const relativePath = path.relative(mediaRoot, filePath).split(path.sep).join('/');
    const { title, category } = catalogDetails(filePath);
    return {
      id: makeId(relativePath, usedIds),
      title,
      category,
      file_path: relativePath,
      subtitles: findSubtitles(filePath, allFiles),
    };
  });

  const previous = await readFile(videosFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const nextContents = `${JSON.stringify(catalog, null, 2)}\n`;
  if (previous === nextContents) {
    console.log(`Catalog is already up to date (${catalog.length} videos).`);
    return;
  }

  const temporaryFile = `${videosFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, nextContents, 'utf8');
  await rename(temporaryFile, videosFile);
  console.log(`Wrote ${catalog.length} videos to ${videosFile}.`);
}

main().catch((error) => {
  console.error(`Catalog generation failed: ${error.message}`);
  process.exitCode = 1;
});