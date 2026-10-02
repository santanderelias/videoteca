const player = document.querySelector('#player');
const playerShell = document.querySelector('.player-shell');
const backgroundAudio = new Audio();
backgroundAudio.preload = 'none';
const placeholder = document.querySelector('#player-placeholder');
const titleElement = document.querySelector('#now-playing-title');
const statusElement = document.querySelector('#player-status');
const videoList = document.querySelector('#video-list');
const recentList = document.querySelector('#recent-list');
const recentCountElement = document.querySelector('#recent-count');
const recentMoreButton = document.querySelector('#recent-more');
const playlistList = document.querySelector('#playlist-list');
const playlistCountElement = document.querySelector('#queue-count');
const playlistTabCountElement = document.querySelector('#playlist-count');
const sidebarTabs = [...document.querySelectorAll('.sidebar-tab')];
const sidebarPanels = [...document.querySelectorAll('.sidebar-panel')];
const searchInput = document.querySelector('#search');
const countElement = document.querySelector('#video-count');
const searchWrap = document.querySelector('#search-wrap');
const subtitleSelect = document.querySelector('#subtitle-select');
const folderHeadingLabel = document.querySelector('#folder-heading-label');
const searchToggle = document.querySelector('#search-toggle');
const searchClose = document.querySelector('#search-close');
const collapseFoldersButton = document.querySelector('#collapse-folders');
const theaterToggle = document.querySelector('#theater-toggle');
const theaterReopen = document.querySelector('#theater-reopen');
const theaterCollapse = document.querySelector('#theater-collapse');
const playToggle = document.querySelector('#play-toggle');
const skipBackButton = document.querySelector('#skip-back');
const skipForwardButton = document.querySelector('#skip-forward');
const fullscreenToggle = document.querySelector('#fullscreen-toggle');
const pipToggle = document.querySelector('#pip-toggle');
const timeline = document.querySelector('#timeline');
const currentTimeElement = document.querySelector('#current-time');
const durationElement = document.querySelector('#duration-display');
const resumeDialog = document.querySelector('#resume-dialog');
const resumeTitle = document.querySelector('#resume-title');
const resumeDescription = document.querySelector('#resume-description');
const resumeContinueButton = document.querySelector('#resume-continue');
const resumeRestartButton = document.querySelector('#resume-restart');
const resumeDismissButton = document.querySelector('#resume-dismiss');
const progressStorageKey = 'videoteca.playback.v2';
const recentStorageKey = 'videoteca.recent.v1';
const playlistStorageKey = 'videoteca.playlist.v1';

let videos = [];
let selectedId = null;
let streamStartOffset = 0;
let pendingResume = null;
let lastProgressWrite = 0;
let recentVisibleCount = 3;
let totalDuration = 0;
let durationRequestId = 0;
let controlsHideTimer = null;
let touchTapTimer = null;
let mouseClickTimer = null;
let lastTouchTapAt = 0;
let ignoreClickUntil = 0;
let searchMode = false;
let autoPipAttempted = false;
let backgroundAudioMode = false;
let backgroundAudioOffset = 0;
let backgroundAudioRequestId = 0;
let automaticPlaylistIds = [];
let manualPlaylistIds = [];
let removedAutomaticIds = new Set();
const expandedFolders = new Set();
const durationCache = new Map();
const playbackProgress = loadPlaybackProgress();
let recentVideoIds = loadRecentVideos();
({ manualPlaylistIds, removedAutomaticIds } = loadPlaylistState());

function loadPlaybackProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(progressStorageKey) || 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      if (typeof saved.videoId === 'string' && Number.isFinite(saved.time)) return { [saved.videoId]: saved.time };
      return saved;
    }
    const legacy = JSON.parse(localStorage.getItem('videoteca.playback.v1') || 'null');
    return legacy?.videoId && Number.isFinite(legacy.time) ? { [legacy.videoId]: legacy.time } : {};
  } catch {
    return {};
  }
}

function loadRecentVideos() {
  try {
    const saved = JSON.parse(localStorage.getItem(recentStorageKey) || '[]');
    return Array.isArray(saved) ? [...new Set(saved.filter((id) => typeof id === 'string'))] : [];
  } catch {
    return [];
  }
}

function loadPlaylistState() {
  try {
    const saved = JSON.parse(localStorage.getItem(playlistStorageKey) || 'null');
    return {
      manualPlaylistIds: Array.isArray(saved?.manualIds) ? [...new Set(saved.manualIds.filter((id) => typeof id === 'string'))] : [],
      removedAutomaticIds: new Set(Array.isArray(saved?.removedIds) ? saved.removedIds.filter((id) => typeof id === 'string') : []),
    };
  } catch {
    return { manualPlaylistIds: [], removedAutomaticIds: new Set() };
  }
}

function persistPlaylistState() {
  try {
    localStorage.setItem(playlistStorageKey, JSON.stringify({
      manualIds: manualPlaylistIds,
      removedIds: [...removedAutomaticIds],
    }));
  } catch {
    // Playlist changes remain available until this page is closed.
  }
}

function orderedVideos(items) {
  return [...items].sort((left, right) => left.file_path.localeCompare(
    right.file_path,
    undefined,
    { numeric: true, sensitivity: 'base' },
  ));
}

function activePlaylistIds() {
  const seen = new Set(selectedId ? [selectedId] : []);
  const queue = [];
  for (const id of [...automaticPlaylistIds.filter((entry) => !removedAutomaticIds.has(entry)), ...manualPlaylistIds]) {
    if (seen.has(id) || !videos.some((video) => video.id === id)) continue;
    seen.add(id);
    queue.push(id);
  }
  return queue;
}

function isVideoQueued(videoId) {
  return videoId !== selectedId && (
    (automaticPlaylistIds.includes(videoId) && !removedAutomaticIds.has(videoId))
    || manualPlaylistIds.includes(videoId)
  );
}

function setAutomaticPlaylist(video, resetRemoved = true) {
  const videoIndex = videos.findIndex((entry) => entry.id === video.id);
  automaticPlaylistIds = videoIndex >= 0 ? videos.slice(videoIndex + 1).map((entry) => entry.id) : [];
  if (resetRemoved) removedAutomaticIds.clear();
  persistPlaylistState();
}

function togglePlaylist(videoId) {
  const automaticIndex = automaticPlaylistIds.indexOf(videoId);
  if (automaticIndex >= 0 && !removedAutomaticIds.has(videoId)) {
    removedAutomaticIds.add(videoId);
  } else if (automaticIndex >= 0) {
    removedAutomaticIds.delete(videoId);
  } else if (manualPlaylistIds.includes(videoId)) {
    manualPlaylistIds = manualPlaylistIds.filter((id) => id !== videoId);
  } else {
    manualPlaylistIds.push(videoId);
  }
  persistPlaylistState();
  renderVideos();
  renderRecent();
  renderPlaylist();
}

function persistProgress() {
  try {
    localStorage.setItem(progressStorageKey, JSON.stringify(playbackProgress));
  } catch {
    // Playback continues normally when browser storage is disabled or full.
  }
}

function savePlaybackProgress() {
  if (!selectedId) return;
  const sourceTime = backgroundAudioMode
    ? backgroundAudioOffset + (Number.isFinite(backgroundAudio.currentTime) ? backgroundAudio.currentTime : 0)
    : streamStartOffset + (Number.isFinite(player.currentTime) ? player.currentTime : 0);
  if (!backgroundAudioMode && !player.currentSrc) return;
  const time = sourceTime;
  if (time <= 0) return;
  playbackProgress[selectedId] = time;
  persistProgress();
  lastProgressWrite = Date.now();
}

function clearPlaybackProgress(videoId) {
  delete playbackProgress[videoId];
  persistProgress();
}

function setStatus(message) {
  statusElement.textContent = message;
}

function buildFolderTree() {
  const root = { name: '', path: '', folders: new Map(), videos: [] };
  for (const video of videos) {
    const parts = (video.file_path || '').split(/[\\/]+/).filter(Boolean);
    parts.pop();
    let node = root;
    const pathParts = [];
    for (const part of parts) {
      pathParts.push(part);
      if (!node.folders.has(part)) {
        node.folders.set(part, {
          name: part,
          path: pathParts.join('/'),
          folders: new Map(),
          videos: [],
        });
      }
      node = node.folders.get(part);
    }
    node.videos.push(video);
  }
  return root;
}

function folderMatches(node, query) {
  if (node.videos.some((video) => `${video.title} ${video.category} ${video.file_path}`.toLocaleLowerCase().includes(query))) return true;
  return [...node.folders.values()].some((folder) => folderMatches(folder, query));
}

function renderFolder(node, query, groupId) {
  const item = document.createElement('div');
  item.setAttribute('role', 'none');

  const toggle = document.createElement('button');
  toggle.className = 'tree-folder-toggle';
  toggle.type = 'button';
  toggle.dataset.folderPath = node.path;
  toggle.setAttribute('role', 'treeitem');
  toggle.setAttribute('aria-expanded', String(Boolean(query) || expandedFolders.has(node.path)));
  toggle.setAttribute('aria-controls', groupId);

  const glyph = document.createElement('span');
  glyph.className = 'folder-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = node.name;
  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = String(countVideos(node));
  toggle.append(glyph, label, count);

  const group = document.createElement('div');
  group.className = 'tree-children';
  group.id = groupId;
  group.setAttribute('role', 'group');
  group.hidden = !query && !expandedFolders.has(node.path);

  const childFolders = [...node.folders.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
  for (const child of childFolders) {
    if (!query || folderMatches(child, query)) {
      group.append(renderFolder(child, query, `folder-group-${groupId}-${group.children.length}`));
    }
  }
  const matchingVideos = node.videos
    .filter((video) => !query || `${video.title} ${video.category} ${video.file_path}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.file_path.localeCompare(right.file_path, undefined, { numeric: true, sensitivity: 'base' }));
  for (const video of matchingVideos) group.append(renderVideo(video));

  item.append(toggle, group);
  return item;
}

function countVideos(node) {
  return node.videos.length + [...node.folders.values()].reduce((total, folder) => total + countVideos(folder), 0);
}

function renderVideo(video, { playlistEntry = false } = {}) {
  const item = document.createElement('div');
  item.className = playlistEntry ? 'video-entry playlist-entry' : 'video-entry';
  item.setAttribute('role', playlistEntry ? 'listitem' : 'none');
  const button = document.createElement('button');
  button.className = 'video-row';
  button.type = 'button';
  button.dataset.videoId = video.id;
  if (!playlistEntry) button.setAttribute('role', 'treeitem');
  button.setAttribute('aria-current', String(video.id === selectedId));

  const marker = document.createElement('span');
  marker.className = 'video-marker';
  marker.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'row-title';
  title.textContent = video.title;
  button.append(marker, title);
  const isQueued = isVideoQueued(video.id);
  const queueButton = document.createElement('button');
  queueButton.className = 'playlist-toggle';
  queueButton.type = 'button';
  queueButton.dataset.playlistId = video.id;
  queueButton.textContent = isQueued ? '×' : '+';
  queueButton.setAttribute('aria-label', `${isQueued ? 'Remove from' : 'Add to'} playlist: ${video.title}`);
  queueButton.title = isQueued ? 'Remove from playlist' : 'Add to playlist';
  if (playlistEntry) queueButton.classList.add('playlist-remove');
  item.append(button, queueButton);
  return item;
}

function renderRecent() {
  const recentVideos = recentVideoIds
    .map((id) => videos.find((video) => video.id === id))
    .filter(Boolean);
  recentCountElement.textContent = String(recentVideos.length);
  const visibleVideos = recentVideos.slice(0, recentVisibleCount);
  recentList.replaceChildren(...visibleVideos.map(renderVideo));
  if (!visibleVideos.length) {
    const empty = document.createElement('p');
    empty.className = 'recent-empty';
    empty.textContent = 'Nothing played yet.';
    recentList.append(empty);
  }
  recentMoreButton.hidden = recentVideos.length <= recentVisibleCount;
}

function renderPlaylist() {
  const queuedVideos = activePlaylistIds()
    .map((id) => videos.find((video) => video.id === id))
    .filter(Boolean);
  playlistCountElement.textContent = String(queuedVideos.length);
  playlistTabCountElement.textContent = String(queuedVideos.length);
  if (queuedVideos.length) {
    playlistList.replaceChildren(...queuedVideos.map((video) => renderVideo(video, { playlistEntry: true })));
  } else {
    const empty = document.createElement('p');
    empty.className = 'playlist-empty';
    empty.textContent = selectedId ? 'No videos up next.' : 'Choose a video to build an automatic queue.';
    playlistList.replaceChildren(empty);
  }
}

function recordRecent(video) {
  recentVideoIds = [video.id, ...recentVideoIds.filter((id) => id !== video.id)].slice(0, 100);
  try {
    localStorage.setItem(recentStorageKey, JSON.stringify(recentVideoIds));
  } catch {
    // Recent history is optional when browser storage is disabled or full.
  }
  renderRecent();
}

function renderVideos() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  countElement.textContent = `${videos.length} ${videos.length === 1 ? 'title' : 'titles'}`;
  const tree = buildFolderTree();
  const rootFolders = [...tree.folders.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
  const rootVideos = tree.videos
    .filter((video) => !query || `${video.title} ${video.category} ${video.file_path}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.file_path.localeCompare(right.file_path, undefined, { numeric: true, sensitivity: 'base' }));
  const treeNodes = rootFolders
    .filter((folder) => !query || folderMatches(folder, query))
    .map((folder, index) => renderFolder(folder, query, `folder-group-${index}`));
  treeNodes.push(...rootVideos.map(renderVideo));

  if (!treeNodes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = videos.length ? 'No titles match this search.' : 'Add titles to videos.json to start your library.';
    videoList.replaceChildren(empty);
    return;
  }
  videoList.replaceChildren(...treeNodes);
}

function expandVideoFolders(video) {
  const parts = (video.file_path || '').split(/[\\/]+/).filter(Boolean);
  parts.pop();
  let currentPath = '';
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    expandedFolders.add(currentPath);
  }
}

function updateSubtitles(video) {
  player.querySelectorAll('track').forEach((track) => track.remove());
  subtitleSelect.replaceChildren(new Option('Off', 'off'));
  subtitleSelect.disabled = video.subtitles.length === 0;

  video.subtitles.forEach((subtitle, index) => {
    const option = new Option(subtitle.label, String(index));
    subtitleSelect.add(option);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = subtitle.label;
    track.srclang = subtitle.lang;
    track.src = subtitle.src;
    player.append(track);
  });
  subtitleSelect.value = 'off';
}

function showResumePrompt(video, resumeTime, startup = false) {
  pendingResume = { video, time: resumeTime };
  resumeTitle.textContent = startup ? 'Continue watching?' : 'Resume video?';
  resumeDescription.textContent = `${video.title} · ${formatTime(resumeTime)}`;
  resumeDialog.showModal();
}

function selectVideo(video) {
  savePlaybackProgress();
  const resumeTime = playbackProgress[video.id];
  if (Number.isFinite(resumeTime) && resumeTime > 5) {
    showResumePrompt(video, resumeTime);
    return;
  }
  startPlayback(video);
}

function setDuration(duration, requestId) {
  if (requestId !== durationRequestId) return;
  totalDuration = duration;
  timeline.max = String(Math.ceil(duration));
  timeline.disabled = false;
  durationElement.textContent = formatTime(duration);
  updatePlaybackControls();
}

async function loadDuration(video, requestId) {
  if (durationCache.has(video.id)) {
    setDuration(durationCache.get(video.id), requestId);
    return;
  }
  try {
    const response = await fetch(video.info);
    if (!response.ok) throw new Error('Could not read duration');
    const { duration } = await response.json();
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid duration');
    durationCache.set(video.id, duration);
    setDuration(duration, requestId);
  } catch {
    if (requestId === durationRequestId) durationElement.textContent = '--:--';
  }
}

function startPlayback(video, startTime = 0, autoplay = true, saveCurrentProgress = true) {
  if (saveCurrentProgress && !player.ended) savePlaybackProgress();
  stopBackgroundAudio();
  const changedVideo = selectedId !== video.id;
  selectedId = video.id;
  autoPipAttempted = false;
  updatePictureInPictureControl();
  if (changedVideo) {
    manualPlaylistIds = manualPlaylistIds.filter((id) => id !== video.id);
    setAutomaticPlaylist(video);
  }
  streamStartOffset = startTime;
  expandVideoFolders(video);
  titleElement.textContent = video.title;
  setPlayerControlsVisible(true);
  setStatus('Connecting to the media server…');
  placeholder.classList.remove('is-hidden');
  updateSubtitles(video);
  const requestId = ++durationRequestId;
  totalDuration = durationCache.get(video.id) || 0;
  timeline.disabled = !totalDuration;
  timeline.value = String(Math.floor(startTime));
  currentTimeElement.textContent = formatTime(startTime);
  durationElement.textContent = totalDuration ? formatTime(totalDuration) : '…';
  player.src = startTime > 0 ? `${video.stream}?start=${encodeURIComponent(startTime)}` : video.stream;
  player.load();
  renderVideos();
  renderRecent();
  renderPlaylist();
  loadDuration(video, requestId);
  if (autoplay) {
    player.play().catch(() => {
      setStatus('Press play to begin. Some video codecs may not be supported by this browser.');
    });
  } else {
    setStatus('Paused. Press play when you are ready.');
  }
}

function currentPosition() {
  if (backgroundAudioMode) return Math.max(0, backgroundAudioOffset + backgroundAudio.currentTime);
  return Math.max(0, streamStartOffset + (Number.isFinite(player.currentTime) ? player.currentTime : 0));
}

function stopBackgroundAudio() {
  if (!backgroundAudioMode && backgroundAudio.paused) return;
  backgroundAudioRequestId += 1;
  backgroundAudio.pause();
  backgroundAudio.removeAttribute('src');
  backgroundAudio.load();
  backgroundAudioMode = false;
}

async function startBackgroundAudio() {
  const video = videos.find((entry) => entry.id === selectedId);
  if (!video?.audio || backgroundAudioMode || player.paused || player.ended) return;

  backgroundAudioOffset = currentPosition();
  savePlaybackProgress();
  backgroundAudio.src = `${video.audio}?start=${encodeURIComponent(backgroundAudioOffset)}`;
  backgroundAudio.volume = player.volume;
  backgroundAudioMode = true;
  const requestId = ++backgroundAudioRequestId;

  try {
    await backgroundAudio.play();
    if (requestId !== backgroundAudioRequestId || !backgroundAudioMode) return;
    if (document.visibilityState !== 'hidden') {
      resumeVideoFromBackgroundAudio();
      return;
    }
    player.pause();
    setStatus('Audio continues in the background.');
  } catch {
    if (requestId !== backgroundAudioRequestId) return;
    backgroundAudioMode = false;
    setStatus('Background audio was blocked by the browser.');
  }
}

function resumeVideoFromBackgroundAudio() {
  if (!backgroundAudioMode) return;
  const video = videos.find((entry) => entry.id === selectedId);
  const resumeAt = currentPosition();
  stopBackgroundAudio();
  if (video) startPlayback(video, resumeAt, true, false);
}

function updatePlaybackControls() {
  const position = currentPosition();
  currentTimeElement.textContent = formatTime(position);
  if (totalDuration > 0) timeline.value = String(Math.min(Math.floor(position), Math.ceil(totalDuration)));
  playToggle.textContent = player.paused ? '▶' : 'Ⅱ';
  playToggle.setAttribute('aria-label', player.paused ? 'Play' : 'Pause');
  playToggle.title = player.paused ? 'Play' : 'Pause';
}

function seekTo(position) {
  const video = videos.find((entry) => entry.id === selectedId);
  if (!video) return;
  const target = Math.max(0, totalDuration ? Math.min(position, totalDuration) : position);
  if (Math.abs(target - currentPosition()) < 1) return;
  startPlayback(video, target, !player.paused);
}

function setPlayerControlsVisible(visible) {
  playerShell.classList.toggle('controls-hidden', !visible);
  if (controlsHideTimer) clearTimeout(controlsHideTimer);
  controlsHideTimer = null;
}

function schedulePlayerControlsHide(delay = 5000) {
  if (player.paused) return;
  if (controlsHideTimer) clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(() => {
    controlsHideTimer = null;
    setPlayerControlsVisible(player.paused);
  }, delay);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (playerShell.requestFullscreen) await playerShell.requestFullscreen();
    else if (player.webkitEnterFullscreen) player.webkitEnterFullscreen();
  } catch {
    setStatus('Fullscreen is not available in this browser.');
  }
}

function isPlayerControl(target) {
  return Boolean(target.closest('.playback-controls, .player-subtitle-control'));
}

playerShell.addEventListener('pointerup', (event) => {
  if (event.pointerType !== 'touch' || isPlayerControl(event.target)) return;

  const now = Date.now();
  ignoreClickUntil = now + 650;
  const bounds = player.getBoundingClientRect();
  const touchX = event.clientX - bounds.left;
  const doubled = now - lastTouchTapAt <= 330;

  if (touchTapTimer) clearTimeout(touchTapTimer);
  touchTapTimer = null;

  if (doubled) {
    lastTouchTapAt = 0;
    const direction = touchX < bounds.width / 2 ? -10 : 10;
    seekTo(currentPosition() + direction);
    setPlayerControlsVisible(true);
    schedulePlayerControlsHide(5000);
    return;
  }

  lastTouchTapAt = now;
  if (player.paused) {
    setPlayerControlsVisible(true);
    return;
  }
  if (playerShell.classList.contains('controls-hidden')) {
    setPlayerControlsVisible(true);
    schedulePlayerControlsHide(5000);
  } else {
    touchTapTimer = setTimeout(() => {
      setPlayerControlsVisible(player.paused);
      touchTapTimer = null;
    }, 330);
  }
});

playerShell.addEventListener('click', (event) => {
  if (Date.now() < ignoreClickUntil || isPlayerControl(event.target)) return;
  if (event.detail > 1) {
    if (mouseClickTimer) clearTimeout(mouseClickTimer);
    mouseClickTimer = null;
    return;
  }

  if (mouseClickTimer) clearTimeout(mouseClickTimer);
  mouseClickTimer = setTimeout(() => {
    if (player.paused) player.play().catch(() => setStatus('Press play to begin playback.'));
    else player.pause();
    mouseClickTimer = null;
  }, 260);
});

playerShell.addEventListener('dblclick', (event) => {
  if (Date.now() < ignoreClickUntil || isPlayerControl(event.target)) return;
  event.preventDefault();
  if (mouseClickTimer) clearTimeout(mouseClickTimer);
  mouseClickTimer = null;
  setPlayerControlsVisible(true);
  toggleFullscreen();
});

playerShell.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'mouse' || player.paused) return;
  setPlayerControlsVisible(true);
  schedulePlayerControlsHide();
});

function activateSidebarTab(tab) {
  for (const sidebarTab of sidebarTabs) {
    const selected = sidebarTab === tab;
    sidebarTab.setAttribute('aria-selected', String(selected));
    document.querySelector(`#${sidebarTab.getAttribute('aria-controls')}`).hidden = !selected;
  }
}

function toggleTheaterMode(enabled) {
  document.body.classList.toggle('theater-mode', enabled);
  document.body.classList.remove('theater-library-open');
  theaterToggle.setAttribute('aria-label', enabled ? 'Exit theater mode' : 'Enter theater mode');
  theaterToggle.title = enabled ? 'Exit theater mode' : 'Theater mode';
}

function supportsPictureInPicture() {
  return Boolean(document.pictureInPictureEnabled && typeof player.requestPictureInPicture === 'function');
}

function isMobilePlaybackClient() {
  return navigator.userAgentData?.mobile ?? window.matchMedia('(pointer: coarse)').matches;
}

function updatePictureInPictureControl() {
  const active = document.pictureInPictureElement === player;
  pipToggle.disabled = !selectedId || !supportsPictureInPicture();
  pipToggle.setAttribute('aria-label', active ? 'Exit picture-in-picture' : 'Enter picture-in-picture');
  pipToggle.title = active ? 'Exit picture-in-picture' : 'Picture-in-picture';
}

async function togglePictureInPicture() {
  if (!supportsPictureInPicture()) {
    setStatus('Picture-in-picture is not supported by this browser.');
    return;
  }
  try {
    if (document.pictureInPictureElement === player) await document.exitPictureInPicture();
    else await player.requestPictureInPicture();
  } catch {
    setStatus('Picture-in-picture was blocked by the browser.');
  }
}

function showSearchInput() {
  searchMode = true;
  folderHeadingLabel.textContent = 'SEARCH RESULTS';
  collapseFoldersButton.hidden = true;
  searchClose.hidden = false;
  searchToggle.setAttribute('aria-label', 'Edit search');
  searchToggle.title = 'Edit search';
  searchWrap.hidden = false;
  searchInput.focus();
}

function closeSearchMode() {
  searchMode = false;
  folderHeadingLabel.textContent = 'FOLDERS';
  collapseFoldersButton.hidden = false;
  searchClose.hidden = true;
  searchToggle.setAttribute('aria-label', 'Search titles');
  searchToggle.title = 'Search titles';
  searchWrap.hidden = true;
  searchInput.value = '';
  renderVideos();
}

subtitleSelect.addEventListener('change', () => {
  const selectedIndex = Number.parseInt(subtitleSelect.value, 10);
  for (const [index, track] of [...player.textTracks].entries()) {
    track.mode = index === selectedIndex ? 'showing' : 'disabled';
  }
});

function handleVideoListClick(event) {
  const playlistButton = event.target.closest('[data-playlist-id]');
  if (playlistButton) {
    togglePlaylist(playlistButton.dataset.playlistId);
    return;
  }

  const folderToggle = event.target.closest('[data-folder-path]');
  if (folderToggle) {
    const folderPath = folderToggle.dataset.folderPath;
    if (expandedFolders.has(folderPath)) expandedFolders.delete(folderPath);
    else expandedFolders.add(folderPath);
    renderVideos();
    return;
  }

  const videoButton = event.target.closest('[data-video-id]');
  if (videoButton) {
    const video = videos.find((entry) => entry.id === videoButton.dataset.videoId);
    if (video) selectVideo(video);
  }
}

videoList.addEventListener('click', handleVideoListClick);
recentList.addEventListener('click', handleVideoListClick);
playlistList.addEventListener('click', handleVideoListClick);

  for (const tab of sidebarTabs) {
    tab.addEventListener('click', () => activateSidebarTab(tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const index = (sidebarTabs.indexOf(tab) + direction + sidebarTabs.length) % sidebarTabs.length;
      sidebarTabs[index].focus();
      activateSidebarTab(sidebarTabs[index]);
    });
  }

  recentMoreButton.addEventListener('click', () => {
    recentVisibleCount += 3;
    renderRecent();
  });

  collapseFoldersButton.addEventListener('click', () => {
    expandedFolders.clear();
    renderVideos();
  });

  resumeContinueButton.addEventListener('click', () => {
    resumeDialog.close();
    if (pendingResume) startPlayback(pendingResume.video, pendingResume.time);
  });
  resumeRestartButton.addEventListener('click', () => {
    resumeDialog.close();
    if (pendingResume) {
      clearPlaybackProgress(pendingResume.video.id);
      startPlayback(pendingResume.video);
    }
  });
  resumeDismissButton.addEventListener('click', () => resumeDialog.close());

  playToggle.addEventListener('click', () => {
    if (player.paused) player.play().catch(() => setStatus('Press play to begin playback.'));
    else player.pause();
  });
  skipBackButton.addEventListener('click', () => seekTo(currentPosition() - 10));
  skipForwardButton.addEventListener('click', () => seekTo(currentPosition() + 10));
  timeline.addEventListener('input', () => {
    currentTimeElement.textContent = formatTime(Number(timeline.value));
  });
  timeline.addEventListener('change', () => seekTo(Number(timeline.value)));
  theaterToggle.addEventListener('click', () => toggleTheaterMode(!document.body.classList.contains('theater-mode')));
  theaterReopen.addEventListener('click', () => document.body.classList.add('theater-library-open'));
  theaterCollapse.addEventListener('click', () => document.body.classList.remove('theater-library-open'));
  fullscreenToggle.addEventListener('click', async () => {
    await toggleFullscreen();
  });
  pipToggle.addEventListener('click', togglePictureInPicture);
  player.addEventListener('enterpictureinpicture', updatePictureInPictureControl);
  player.addEventListener('leavepictureinpicture', updatePictureInPictureControl);

  player.addEventListener('playing', () => {
    placeholder.classList.add('is-hidden');
    setStatus(streamStartOffset > 0 ? 'Resumed from your last position.' : 'Streaming from your private network.');
    autoPipAttempted = false;
    const video = videos.find((entry) => entry.id === selectedId);
    if (video) recordRecent(video);
    updatePlaybackControls();
    setPlayerControlsVisible(true);
    schedulePlayerControlsHide();
  });
  player.addEventListener('waiting', () => {
    setStatus('Buffering…');
    setPlayerControlsVisible(true);
  });
  player.addEventListener('error', () => {
    placeholder.classList.remove('is-hidden');
    setStatus('Playback failed. Check the media file, FFmpeg, and browser codec support.');
    setPlayerControlsVisible(true);
  });
  player.addEventListener('pause', () => {
    if (player.currentSrc && player.currentSrc === player.src && !player.ended) {
      savePlaybackProgress();
      setStatus('Playback paused.');
    }
    setPlayerControlsVisible(true);
    updatePlaybackControls();
  });
  player.addEventListener('timeupdate', () => {
    if (Date.now() - lastProgressWrite >= 3000) savePlaybackProgress();
    updatePlaybackControls();
  });
  backgroundAudio.addEventListener('timeupdate', () => {
    if (backgroundAudioMode && Date.now() - lastProgressWrite >= 3000) savePlaybackProgress();
  });
  backgroundAudio.addEventListener('ended', () => {
    if (!backgroundAudioMode || !selectedId) return;
    const resumeTime = totalDuration > 10 ? totalDuration - 5 : currentPosition();
    if (resumeTime > 5) {
      playbackProgress[selectedId] = resumeTime;
      persistProgress();
    }
  });
  player.addEventListener('play', updatePlaybackControls);
  player.addEventListener('ended', () => {
    setPlayerControlsVisible(true);
    if (!selectedId) return;
    const resumeTime = totalDuration > 10 ? totalDuration - 5 : currentPosition();
    if (resumeTime > 5) {
      playbackProgress[selectedId] = resumeTime;
      persistProgress();
    } else {
      clearPlaybackProgress(selectedId);
    }
    const nextId = activePlaylistIds()[0];
    const nextVideo = videos.find((video) => video.id === nextId);
    if (nextVideo) selectVideo(nextVideo);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      savePlaybackProgress();
      if (isMobilePlaybackClient() && selectedId && !player.paused && !player.ended && document.pictureInPictureElement !== player) {
        startBackgroundAudio();
      } else if (!isMobilePlaybackClient() && !autoPipAttempted && selectedId && !player.paused && !player.ended && supportsPictureInPicture() && document.pictureInPictureElement !== player) {
        autoPipAttempted = true;
        player.requestPictureInPicture().catch(() => {});
      }
    } else {
      autoPipAttempted = false;
      resumeVideoFromBackgroundAudio();
    }
  });
  window.addEventListener('pagehide', savePlaybackProgress);

  searchInput.addEventListener('input', renderVideos);
  searchToggle.addEventListener('click', showSearchInput);
  searchClose.addEventListener('click', closeSearchMode);
  searchInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (searchWrap.contains(document.activeElement)) return;
      searchWrap.hidden = true;
      if (!searchInput.value.trim()) closeSearchMode();
    }, 0);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
    }
  });

  async function loadCatalog() {
    try {
      const response = await fetch('/api/videos');
      if (!response.ok) throw new Error('Catalog request failed');
      videos = orderedVideos(await response.json());
      renderVideos();
      renderRecent();
      renderPlaylist();

      const latestRecent = recentVideoIds.find((id) => Number.isFinite(playbackProgress[id]) && playbackProgress[id] > 5);
      const legacyResumeId = Object.keys(playbackProgress).find((id) => Number.isFinite(playbackProgress[id]) && playbackProgress[id] > 5);
      const resumeId = latestRecent || legacyResumeId;
      const video = resumeId && videos.find((entry) => entry.id === resumeId);
      if (video) {
        const savedTime = playbackProgress[video.id];
        expandVideoFolders(video);
        renderVideos();
        setAutomaticPlaylist(video, false);
        renderPlaylist();
        pendingResume = { video, time: Math.floor(savedTime) };
        resumeTitle.textContent = 'Continue watching?';
        resumeDescription.textContent = `${video.title} · ${formatTime(savedTime)}`;
        resumeDialog.showModal();
      }
    } catch {
      setStatus('Could not load the catalog. Check that the media server is running.');
      videoList.innerHTML = '<p class="empty-state">Catalog unavailable. Check the server configuration.</p>';
    }
}

document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  fullscreenToggle.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  fullscreenToggle.title = active ? 'Exit fullscreen' : 'Fullscreen';
});

function formatTime(seconds) {
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

loadCatalog();