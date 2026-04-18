---
title: OtamoNote
emoji: 🎵
colorFrom: pink
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# OtamoNote

Drops any melody onto an otamatone's continuous pitch stem so you can actually play it on one. Upload audio or paste a YouTube URL — the app runs [basic-pitch](https://github.com/spotify/basic-pitch) for pitch detection, auto-transposes into the instrument's range, and plots each note as a percentage along the stem.

Includes a browser simulator (the tadpole) so you can hear what it should sound like before you attempt it on the real toy.

## Run locally

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5001

## Stack

Flask · basic-pitch (Spotify) · librosa · yt-dlp · vanilla JS + Web Audio API
