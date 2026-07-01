# Instagram cookies setup for MgreSV Worker

The error:

`Instagram sent an empty media response`

means Instagram did not return the real media to yt-dlp. Usually the post/Reel needs login, cookies, or is not publicly accessible from the Railway worker IP.

## Safer first checks

1. Open the IG link in incognito/private browser.
2. If it asks login, the worker also cannot access it without cookies.
3. Try a truly public Reel/Post first.

## Enable cookies for yt-dlp

Use ONE of these ENV values on the Railway Worker service:

```env
YTDLP_COOKIES_B64=base64_of_cookies_txt
```

or:

```env
YTDLP_COOKIES=raw_netscape_cookies_txt_with_\n
```

Recommended: `YTDLP_COOKIES_B64`.

## How to make YTDLP_COOKIES_B64 on Windows

1. Export Instagram cookies as Netscape `cookies.txt` from your browser.
2. Put `cookies.txt` in a folder.
3. Run PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\cookies.txt")) | Set-Clipboard
```

4. Paste the clipboard content into Railway ENV:

```env
YTDLP_COOKIES_B64=<paste_here>
```

5. Redeploy Worker.

## Important

- Do NOT put cookies in Vercel frontend ENV.
- Do NOT share cookies publicly.
- Cookies can expire.
- Instagram can still block Railway IP.
- Using a personal Instagram account cookie can risk logout, challenge, or account restriction.
