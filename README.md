# Social Saver Worker

Worker untuk proses download dan convert.

## Endpoint

```http
POST /api/download
```

Body:

```json
{
  "url": "https://...",
  "platform": "youtube",
  "mediaGroup": "video",
  "quality": "1080p",
  "fileType": "mp4"
}
```

## Deploy Railway

Deploy folder `worker` ke Railway.

Set environment variables:

```env
WORKER_TOKEN=token-yang-sama
PUBLIC_BASE_URL=https://nama-worker-kamu.up.railway.app
```

Masukkan ini ke Vercel:

```env
DOWNLOADER_WORKER_URL=https://nama-worker-kamu.up.railway.app/api/download
DOWNLOADER_WORKER_TOKEN=token-yang-sama
```

## Worker Deno Fix v3.0.2

Versi ini memperbaiki warning:

```text
No supported JavaScript runtime could be found
```

Perubahan:
- Dockerfile memasang Deno.
- yt-dlp dipasang dengan `yt-dlp[default]`.
- command yt-dlp memakai `--js-runtimes deno`.
- retry ringan dan sleep request ditambahkan.
- error 429 dibuat lebih jelas.

Jika masih muncul HTTP 429, artinya IP Railway worker sedang dibatasi oleh YouTube. Tunggu beberapa menit, coba kualitas lebih rendah, atau deploy worker di server/IP lain.
