# MenGinaSV Worker Multi-Platform Fix

Deploy folder ini ke Railway/Koyeb/VPS.

## ENV

```env
WORKER_TOKEN=token-kamu
PUBLIC_BASE_URL=https://domain-worker-kamu.up.railway.app
COBALT_API_URL=https://domain-cobalt-kamu.up.railway.app
COBALT_API_KEY=
RATE_LIMIT_PER_MINUTE=20
```

## Yang diperbaiki

- Cobalt `picker` sekarang dipilih sesuai tab: Video, Audio, atau Foto.
- Cobalt `local-processing` sekarang diproses oleh worker dengan ffmpeg.
- TikTok slideshow/audio lebih aman.
- Instagram multi-post lebih aman.
- X/Twitter GIF/video lebih aman.
- SoundCloud audio diarahkan ke mode audio.
- Kalau Cobalt gagal, baru fallback ke direct-file/yt-dlp.

## Cek

```text
https://domain-worker-kamu.up.railway.app/health
```

Harus muncul:

```json
"engine": "cobalt-api + picker + local-processing + direct-file + yt-dlp + ffmpeg + deno"
```
