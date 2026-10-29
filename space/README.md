---
title: Omran Voices TTS
emoji: 🗣️
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

The two light voices of omran-voices (Piper, formal Arabic): `POST /tts {"text", "voice": "m"|"f"}` → WAV.
Every call needs the owner's key (header `X-Space-Key`); the models live in a private repository.
Source: `space/` in the omran-voices repository.
