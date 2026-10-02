# VideoTeca

A small private-network video library. Express serves the catalog and UI; FFmpeg remuxes each selected file to fragmented MP4 while copying the video stream. The first audio track is converted to AAC for broader browser compatibility; video is not transcoded.

## Requirements

- Arch Linux packages: `sudo pacman -S nodejs npm ffmpeg`
- A modern browser on the phone and server on the same trusted network

From the project directory:

```sh
npm install
mkdir -p src
npm run catalog:generate
npm start
```

The server listens on `0.0.0.0:3000`. If using a firewall, allow TCP port 3000 only on the private LAN. This app has no authentication; do not expose it to the public internet.

## Add media

Put files and subfolders under `src/`, then run `npm run catalog:generate`. The script recursively discovers common video formats and replaces `videos.json`; its `file_path` and subtitle `src` values are relative to `MEDIA_ROOT` (by default, `src/`). Matching WebVTT files beside a video are added automatically. Keep `src/` for media, not application source code.

```json
[
  {
    "id": "film-01",
    "title": "Film title",
    "category": "Movies",
    "file_path": "movies/film.mkv",
    "subtitles": [
      { "label": "English", "src": "movies/film.en.vtt", "lang": "en" }
    ]
  }
]
```

The checked-in catalog is an example; regenerate it after adding your files. To scan a different folder, set `VIDEO_SCAN_DIR=/path/to/folder`; it must be inside `MEDIA_ROOT`. Configure alternate locations with `MEDIA_ROOT=/path/to/media` and `VIDEOS_FILE=/path/to/videos.json`.

## Playback behavior

The stream endpoint runs FFmpeg on demand with fragmented MP4 output and copies video during ordinary playback. AAC audio conversion is used for browser support. The player loads a complete duration from FFprobe, providing a stable seek timeline. Seeking and the +/-10-second buttons restart the stream at the selected offset; on nonzero seeks FFmpeg re-encodes video to H.264 so copied keyframe preroll cannot desynchronize it from audio. FFmpeg and FFprobe are provided by Arch's `ffmpeg` package. HEVC and AV1 playback still depends on the phone's browser and hardware; unsupported codecs are not transcoded during ordinary playback.

The Navigate, Recents, and Playlist sidebar tabs separate browsing, playback history, and the up-next queue. Navigate search opens from the folder header and keeps filtered results visible after the input loses focus; use the X to clear the query and restore folders. The catalog generator naturally sorts media paths so seasons and episode numbers stay in order. Selecting a title builds an automatic queue from the following catalog entries; playlist buttons add or remove titles, and the next queued title starts when playback ends.

Play/pause, +/-10-second skip, the duration timeline, subtitles, Picture-in-Picture, theater mode, and fullscreen controls sit inside the video frame and remain available in fullscreen. PiP can be entered manually with its control. Desktop browsers get a best-effort automatic PiP request when active playback is backgrounded. Mobile/touch clients avoid automatic PiP; while a mobile page is hidden during playback, VideoTeca switches to a seekable audio-only stream and resumes video at that position when the page returns. Browser background-audio policies may still affect playback. Recents stores playback history locally. Per-video progress is stored in the browser and can be resumed or restarted from the library, playlist, recents, or on startup.

## Check streaming

With the server running and a real video registered in `videos.json`:

```sh
npm run test:stream -- film-01
```

The probe checks the health and catalog routes and reads the MP4 header from the stream. To verify phone playback, find the Arch host's LAN address with `ip -brief address`, then open `http://HOST-LAN-IP:3000` on the phone and select the registered title. Keep the phone on the same Wi-Fi network.

## Run as a systemd user service

The supplied `media-server.service` assumes the project is at `~/videoTeca` and media is under `~/videoTeca/src`. Adjust those paths in the unit if needed, then install and enable it:

```sh
mkdir -p ~/.config/systemd/user
cp media-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now media-server.service
systemctl --user status media-server.service
```

To keep the service running after logout, enable lingering for your account with `sudo loginctl enable-linger "$USER"`.