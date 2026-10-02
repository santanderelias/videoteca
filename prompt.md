Build a custom, lightweight self-hosted web application for streaming video files (specifically .mkv containers, as well as .mp4, .webm, etc.) across a local private network. 

The application will run on an Arch Linux host and be accessed primarily via modern mobile browsers (iOS/Android Safari/Chrome).

---

### Core Requirements & Architecture

1. Base & Architecture:
   - Host OS: Arch Linux.
   - Backend Tech Stack: Node.js (Express), Go, or Python (FastAPI). Pick the best fit for low-latency streaming and subprocess streaming handling.
   - Video Serving Strategy: DO NOT re-encode video streams unless strictly necessary. Implement on-the-fly REMUXING via FFmpeg.
     - Accept `.mkv` files as inputs.
     - Demux video/audio tracks and wrap them into a fragmented MP4 stream (`-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof`) or HLS pipeline output on the fly.
     - Copy existing video streams (`-c:v copy`) whenever supported by browsers (H.264, HEVC, AV1) to ensure low CPU usage on the Arch server.

2. Media Declaration (JSON Configuration):
   - Media directory contents and video files must NOT rely on dynamic directory scraping alone.
   - Define a `videos.json` file schema to register available movies/series with explicit or relative path routes.
   - Example JSON format:
     ```json
     [
       {
         "id": "movie-1",
         "title": "Example Movie Title",
         "category": "Movies",
         "file_path": "./media/movies/file.mkv",
         "subtitles": [
           { "label": "Spanish", "src": "./media/movies/file_es.vtt", "lang": "es" },
           { "label": "English", "src": "./media/movies/file_en.vtt", "lang": "en" }
         ]
       }
     ]
     ```
   - Provide routes to serve metadata from this JSON file to the frontend UI.

3. Frontend UI / Directory Directory:
   - Build a clean, mobile-first responsive web frontend (Vanilla HTML/CSS/JS or lightweight framework like Tailwind/Alpine).
   - Display video categories and catalog list driven by `videos.json`.
   - Embed an HTML5 `<video>` player configured to hook into the backend's remuxed stream endpoint.
   - Support subtitle selection (WebVTT track embedding) and basic playback controls.

---

### Deliverables Needed

1. Server source code (Backend service + Static UI routes).
2. Sample `videos.json` configuration file showing relative path mappings.
3. Systemd service template file (`media-server.service`) for running the server on Arch Linux.
4. Arch system prerequisites (e.g., `ffmpeg` package requirement).
5. A simple test command or runner script to verify streaming playback from a local phone browser.