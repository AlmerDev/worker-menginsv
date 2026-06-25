# MenGinaSV Worker

Worker downloader untuk Railway/VPS.

## ENV wajib

```env
WORKER_TOKEN=token-kamu
PUBLIC_BASE_URL=https://domain-worker-kamu.up.railway.app
```

## ENV optional untuk YouTube bot verification

YouTube kadang menolak request dari IP server dan menampilkan:

```text
Sign in to confirm you’re not a bot
Use --cookies-from-browser or --cookies
```

Worker ini support cookies lewat Railway Variables.

### Cara aman pakai cookies

1. Export cookies YouTube dari browser kamu ke format `cookies.txt`.
2. Jangan upload cookies ke GitHub.
3. Convert isi file cookies ke base64.
4. Masukkan ke Railway Variables:

```env
YOUTUBE_COOKIES_B64=hasil_base64_cookies_txt
```

Worker akan decode otomatis ke:

```text
downloads/youtube-cookies.txt
```

Lalu yt-dlp otomatis memakai:

```bash
--cookies downloads/youtube-cookies.txt
```

## Cara convert cookies.txt ke base64

Windows PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt")) | Set-Clipboard
```

Mac/Linux:

```bash
base64 -w 0 cookies.txt
```

Jika di Mac command `-w` error:

```bash
base64 cookies.txt | tr -d '\n'
```

## Cek worker

```text
https://domain-worker-kamu.up.railway.app/health
```

Kalau cookies aktif, response health memuat:

```json
"cookiesEnabled": true
```

## Catatan keamanan

Cookies adalah sesi login. Jangan commit ke GitHub. Jangan pakai akun utama untuk layanan publik. Cookies bisa kedaluwarsa, jadi perlu diganti ulang jika error muncul lagi.
