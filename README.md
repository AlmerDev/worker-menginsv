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
