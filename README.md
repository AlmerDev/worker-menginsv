# MenGinaSV Public Worker

Worker publik gratis untuk MenGinaSV.

## Mode kerja

1. Direct media link diproses paling stabil.
2. Link platform publik dicoba dengan yt-dlp + ffmpeg + deno.
3. Kalau platform memblokir server, worker memberi error yang jelas.
4. Optional external fallback API tersedia jika nanti kamu punya provider sendiri.

## ENV Railway

```env
WORKER_TOKEN=token-kamu
PUBLIC_BASE_URL=https://domain-worker-kamu.up.railway.app
RATE_LIMIT_PER_MINUTE=20
```

Optional:

```env
EXTERNAL_DOWNLOADER_API_URL=
EXTERNAL_DOWNLOADER_API_KEY=
```

## Cek worker

```text
https://domain-worker-kamu.up.railway.app/health
```

Response harus memuat:

```json
"mode": "public-free"
```

## Catatan

Mode ini tidak memakai cookies login pribadi. Cocok untuk publik karena lebih aman, tapi platform besar tetap bisa membatasi request server.
