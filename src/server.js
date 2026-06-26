import express from "express"
import cors from "cors"
import helmet from "helmet"
import { nanoid } from "nanoid"
import { spawn } from "node:child_process"
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs"
import { basename, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

const app = express()
const PORT = process.env.PORT || 8080
const __dirname = fileURLToPath(new URL(".", import.meta.url))
const rootDir = join(__dirname, "..")
const downloadDir = join(rootDir, "downloads")

const VIDEO_TYPES = ["mp4", "webm", "mkv", "mov", "avi", "m4v", "3gp", "flv"]
const AUDIO_TYPES = ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "webm"]
const PHOTO_TYPES = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "avif"]

const rateStore = new Map()

if (!existsSync(downloadDir)) {
  mkdirSync(downloadDir, { recursive: true })
}

app.use(helmet({ crossOriginResourcePolicy: false }))
app.use(cors())
app.use(express.json({ limit: "1mb" }))

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    mode: "public-free",
    service: "menginasv-public-worker",
    engine: "direct-file + yt-dlp + ffmpeg + deno",
    externalFallback: Boolean(process.env.EXTERNAL_DOWNLOADER_API_URL),
    videoTypes: VIDEO_TYPES,
    audioTypes: AUDIO_TYPES,
    photoTypes: PHOTO_TYPES
  })
})

app.use("/files", express.static(downloadDir, {
  setHeaders: (res, filePath) => {
    res.setHeader("content-disposition", `attachment; filename="${basename(filePath)}"`)
    res.setHeader("cache-control", "no-store")
    res.setHeader("access-control-allow-origin", "*")
    res.setHeader("cross-origin-resource-policy", "cross-origin")
  }
}))

app.post("/api/download", async (req, res) => {
  try {
    const auth = req.headers.authorization || ""
    const requiredToken = process.env.WORKER_TOKEN || ""

    if (requiredToken && auth !== `Bearer ${requiredToken}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized worker token." })
    }

    if (!allowRequest(getClientKey(req))) {
      return res.status(429).json({
        ok: false,
        error: "Terlalu banyak request. Tunggu sebentar lalu coba lagi."
      })
    }

    const url = normalizeUrl(req.body?.url)
    const mediaGroup = normalizeMediaGroup(req.body?.mediaGroup)
    const quality = String(req.body?.quality || "best").toLowerCase()
    const fileType = normalizeFileType(req.body?.fileType, mediaGroup)

    if (!url) {
      return res.status(400).json({ ok: false, error: "URL tidak valid." })
    }

    cleanupOldFiles()

    const jobId = nanoid(10)
    let outputFile = null
    const directType = detectDirectMedia(url)

    if (directType) {
      outputFile = await processDirectMedia({ url, jobId, mediaGroup, fileType })
    } else {
      outputFile = await processWithYtDlpPublic({ url, jobId, mediaGroup, quality, fileType })
    }

    if (!outputFile || !existsSync(outputFile)) {
      const external = await tryExternalFallback({ url, mediaGroup, quality, fileType })
      if (external?.ok) return res.json(external)

      return res.status(422).json({
        ok: false,
        error: "File belum bisa diproses oleh worker public gratis. Coba quality lain, link lain, atau direct media link."
      })
    }

    const publicBase = getPublicBase(req)
    const title = basename(outputFile)
    const downloadUrl = `${publicBase}/files/${encodeURIComponent(title)}`

    return res.json({
      ok: true,
      title,
      mediaGroup,
      quality,
      fileType,
      downloadUrl
    })
  } catch (error) {
    const external = await tryExternalFallbackFromError(req.body)
    if (external?.ok) return res.json(external)

    return res.status(422).json({
      ok: false,
      error: simplifyError(error?.message || "Download gagal.")
    })
  }
})

async function processDirectMedia({ url, jobId, mediaGroup, fileType }) {
  const parsed = new URL(url)
  const sourceExt = extname(parsed.pathname).replace(".", "").toLowerCase()
  const safeSourceExt = sourceExt || fileType
  const sourceFile = join(downloadDir, `${jobId}-source.${safeSourceExt}`)

  await downloadDirectFile(url, sourceFile)

  if (mediaGroup === "video") {
    const currentExt = extname(sourceFile).replace(".", "").toLowerCase()
    if (currentExt === fileType) return sourceFile

    const target = join(downloadDir, `${jobId}.${fileType}`)
    await mustRun("ffmpeg", buildVideoConvertArgs(sourceFile, target, fileType), 240000)
    safeRemove(sourceFile)
    return target
  }

  if (mediaGroup === "audio") {
    const target = join(downloadDir, `${jobId}.${fileType}`)
    await mustRun("ffmpeg", buildAudioConvertArgs(sourceFile, target, fileType, null), 240000)
    safeRemove(sourceFile)
    return target
  }

  if (mediaGroup === "photo") {
    const currentExt = extname(sourceFile).replace(".", "").toLowerCase()
    if (currentExt === fileType) return sourceFile

    const target = join(downloadDir, `${jobId}.${fileType}`)
    await mustRun("ffmpeg", ["-y", "-i", sourceFile, target], 180000)
    safeRemove(sourceFile)
    return target
  }

  return null
}

async function processWithYtDlpPublic({ url, jobId, mediaGroup, quality, fileType }) {
  const attempts = getYtDlpAttempts(url)

  let lastError = null

  for (const attempt of attempts) {
    try {
      if (mediaGroup === "video") {
        return await processVideo({ url, jobId: `${jobId}-${attempt.id}`, quality, fileType, attempt })
      }

      if (mediaGroup === "audio") {
        return await processAudio({ url, jobId: `${jobId}-${attempt.id}`, quality, fileType, attempt })
      }

      if (mediaGroup === "photo") {
        return await processPhoto({ url, jobId: `${jobId}-${attempt.id}`, fileType, attempt })
      }
    } catch (error) {
      lastError = error
      continue
    }
  }

  throw lastError || new Error("Semua engine attempt gagal.")
}

async function processVideo({ url, jobId, quality, fileType, attempt }) {
  const sourceTemplate = join(downloadDir, `${jobId}-source.%(ext)s`)
  const maxHeight = parseVideoHeight(quality)
  const selector = maxHeight
    ? `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`
    : "bestvideo+bestaudio/best"

  await mustRun("yt-dlp", [
    ...ytDlpBaseArgs(sourceTemplate, attempt),
    "--format", selector,
    "--merge-output-format", "mp4",
    url
  ], 300000)

  const source = findFile(`${jobId}-source`)
  if (!source) return null

  const sourceExt = extname(source).replace(".", "").toLowerCase()
  if (sourceExt === fileType) return source

  const target = join(downloadDir, `${jobId}.${fileType}`)
  await mustRun("ffmpeg", buildVideoConvertArgs(source, target, fileType), 260000)
  safeRemove(source)

  return existsSync(target) ? target : null
}

async function processAudio({ url, jobId, quality, fileType, attempt }) {
  const sourceTemplate = join(downloadDir, `${jobId}-audio.%(ext)s`)

  await mustRun("yt-dlp", [
    ...ytDlpBaseArgs(sourceTemplate, attempt),
    "--extract-audio",
    "--audio-format", preferredYtDlpAudioFormat(fileType),
    "--audio-quality", "0",
    url
  ], 300000)

  const source = findFile(`${jobId}-audio`)
  if (!source) return null

  const sourceExt = extname(source).replace(".", "").toLowerCase()
  const target = join(downloadDir, `${jobId}.${fileType}`)
  const bitrate = parseAudioBitrate(quality)

  if (sourceExt === fileType && quality === "best") return source

  await mustRun("ffmpeg", buildAudioConvertArgs(source, target, fileType, bitrate), 260000)
  safeRemove(source)

  return existsSync(target) ? target : null
}

async function processPhoto({ url, jobId, fileType, attempt }) {
  const sourceTemplate = join(downloadDir, `${jobId}-photo.%(ext)s`)

  await mustRun("yt-dlp", [
    ...ytDlpBaseArgs(sourceTemplate, attempt),
    "--skip-download",
    "--write-thumbnail",
    "--convert-thumbnails", fileType === "jpeg" ? "jpg" : fileType,
    url
  ], 220000)

  const source = findFile(`${jobId}-photo`)
  if (!source) return null

  const sourceExt = extname(source).replace(".", "").toLowerCase()
  if (sourceExt === fileType || (fileType === "jpeg" && sourceExt === "jpg")) return source

  const target = join(downloadDir, `${jobId}.${fileType}`)
  await mustRun("ffmpeg", ["-y", "-i", source, target], 180000)
  safeRemove(source)

  return existsSync(target) ? target : null
}

function ytDlpBaseArgs(outputTemplate, attempt) {
  const args = [
    "--no-playlist",
    "--restrict-filenames",
    "--windows-filenames",
    "--newline",
    "--force-ipv4",
    "--retries", "2",
    "--fragment-retries", "2",
    "--sleep-requests", "1",
    "--sleep-interval", "1",
    "--max-sleep-interval", "3",
    "--js-runtimes", "deno",
    "--output", outputTemplate
  ]

  if (attempt?.userAgent) {
    args.push("--user-agent", attempt.userAgent)
  }

  if (attempt?.extractorArgs) {
    args.push("--extractor-args", attempt.extractorArgs)
  }

  return args
}

function getYtDlpAttempts(url) {
  const isYoutube = /youtube\.com|youtu\.be/i.test(url)

  if (!isYoutube) {
    return [
      { id: "default" },
      {
        id: "mobile",
        userAgent: "Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"
      }
    ]
  }

  return [
    { id: "default" },
    {
      id: "android",
      extractorArgs: "youtube:player_client=android",
      userAgent: "com.google.android.youtube/19.09.37 (Linux; U; Android 12)"
    },
    {
      id: "ios",
      extractorArgs: "youtube:player_client=ios",
      userAgent: "com.google.ios.youtube/19.09.3 (iPhone16,2; U; CPU iOS 17_2 like Mac OS X)"
    },
    {
      id: "web",
      extractorArgs: "youtube:player_client=web",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    }
  ]
}

function buildVideoConvertArgs(source, target, fileType) {
  const args = ["-y", "-i", source]

  if (fileType === "webm") {
    args.push("-c:v", "libvpx-vp9", "-c:a", "libopus")
  } else if (fileType === "flv") {
    args.push("-c:v", "flv", "-c:a", "mp3")
  } else if (fileType === "3gp") {
    args.push("-s", "352x288", "-c:v", "h263", "-c:a", "aac")
  } else {
    args.push("-c:v", "libx264", "-c:a", "aac")
  }

  args.push(target)
  return args
}

function buildAudioConvertArgs(source, target, fileType, bitrate) {
  const args = ["-y", "-i", source]

  if (fileType === "mp3") args.push("-codec:a", "libmp3lame")
  if (fileType === "m4a" || fileType === "aac") args.push("-codec:a", "aac")
  if (fileType === "wav") args.push("-codec:a", "pcm_s16le")
  if (fileType === "flac") args.push("-codec:a", "flac")
  if (fileType === "ogg") args.push("-codec:a", "libvorbis")
  if (fileType === "opus") args.push("-codec:a", "libopus")
  if (fileType === "webm") args.push("-codec:a", "libopus")

  if (bitrate && fileType !== "wav" && fileType !== "flac") args.push("-b:a", bitrate)

  args.push(target)
  return args
}

function preferredYtDlpAudioFormat(fileType) {
  if (["mp3", "m4a", "aac", "wav", "flac", "opus"].includes(fileType)) return fileType
  if (fileType === "ogg") return "vorbis"
  return "best"
}

async function downloadDirectFile(url, target) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    }
  })

  if (!response.ok || !response.body) {
    throw new Error("Direct file tidak bisa diambil.")
  }

  await new Promise((resolve, reject) => {
    const fileStream = createWriteStream(target)
    response.body.pipeTo(new WritableStream({
      write(chunk) {
        fileStream.write(Buffer.from(chunk))
      },
      close() {
        fileStream.end()
        resolve()
      },
      abort(error) {
        fileStream.destroy()
        reject(error)
      }
    })).catch(reject)
  })
}

function mustRun(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: downloadDir, env: process.env })

    let stdout = ""
    let stderr = ""
    let done = false

    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGKILL")
      reject(new Error("Process timeout."))
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("close", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)

      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || stdout || `Command failed: ${command}`))
    })

    child.on("error", (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function tryExternalFallback({ url, mediaGroup, quality, fileType }) {
  const apiUrl = process.env.EXTERNAL_DOWNLOADER_API_URL
  if (!apiUrl) return null

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.EXTERNAL_DOWNLOADER_API_KEY ? { authorization: `Bearer ${process.env.EXTERNAL_DOWNLOADER_API_KEY}` } : {})
      },
      body: JSON.stringify({ url, mediaGroup, quality, fileType })
    })

    const data = await response.json().catch(() => null)
    if (response.ok && data?.ok && data?.downloadUrl) {
      return {
        ok: true,
        title: data.title || `external-${Date.now()}.${fileType}`,
        mediaGroup,
        quality,
        fileType,
        downloadUrl: data.downloadUrl
      }
    }

    return null
  } catch {
    return null
  }
}

async function tryExternalFallbackFromError(body) {
  try {
    return await tryExternalFallback({
      url: String(body?.url || ""),
      mediaGroup: normalizeMediaGroup(body?.mediaGroup),
      quality: String(body?.quality || "best"),
      fileType: String(body?.fileType || "mp4")
    })
  } catch {
    return null
  }
}

function normalizeUrl(value) {
  const raw = String(value || "").trim()
  try {
    const parsed = new URL(raw)
    if (!["http:", "https:"].includes(parsed.protocol)) return null
    if (isPrivateHost(parsed.hostname)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase()
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  )
}

function normalizeMediaGroup(value) {
  const mediaGroup = String(value || "video").toLowerCase()
  return ["video", "audio", "photo", "other"].includes(mediaGroup) ? (mediaGroup === "other" ? "video" : mediaGroup) : "video"
}

function normalizeFileType(value, mediaGroup) {
  const fileType = String(value || "").toLowerCase()
  const allowed = mediaGroup === "audio" ? AUDIO_TYPES : mediaGroup === "photo" ? PHOTO_TYPES : VIDEO_TYPES
  return allowed.includes(fileType) ? fileType : allowed[0]
}

function detectDirectMedia(value) {
  const clean = value.split("?")[0].toLowerCase()
  if (clean.match(/\.(mp4|webm|mkv|mov|avi|m4v|3gp|flv)$/)) return "video"
  if (clean.match(/\.(mp3|m4a|wav|aac|flac|ogg|opus)$/)) return "audio"
  if (clean.match(/\.(jpg|jpeg|png|webp|gif|bmp|tiff|avif)$/)) return "photo"
  return null
}

function parseVideoHeight(quality) {
  const match = String(quality).match(/^(\d+)p$/)
  return match ? Number(match[1]) : null
}

function parseAudioBitrate(quality) {
  const match = String(quality).match(/^(\d+)k$/)
  return match ? `${match[1]}k` : null
}

function findFile(prefix) {
  const files = readdirSync(downloadDir)
    .filter((file) => file.startsWith(prefix + ".") || file.startsWith(prefix + "-"))
    .map((file) => join(downloadDir, file))
    .filter((filePath) => statSync(filePath).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  return files[0] || null
}

function getPublicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "")
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http"
  const host = req.headers["x-forwarded-host"] || req.get("host")
  return `${proto}://${host}`
}

function cleanupOldFiles() {
  const now = Date.now()
  const maxAge = 1000 * 60 * 30

  for (const file of readdirSync(downloadDir)) {
    const filePath = join(downloadDir, file)
    try {
      const stats = statSync(filePath)
      if (stats.isFile() && now - stats.mtimeMs > maxAge) rmSync(filePath, { force: true })
    } catch {
      // ignore
    }
  }
}

function safeRemove(filePath) {
  try {
    rmSync(filePath, { force: true })
  } catch {
    // ignore
  }
}

function allowRequest(key) {
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE || 20)
  const now = Date.now()
  const windowMs = 60_000

  const current = rateStore.get(key) || []
  const fresh = current.filter((timestamp) => now - timestamp < windowMs)

  if (fresh.length >= limit) {
    rateStore.set(key, fresh)
    return false
  }

  fresh.push(now)
  rateStore.set(key, fresh)
  return true
}

function getClientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.ip || "unknown").split(",")[0].trim()
}

function simplifyError(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim()
  const lower = text.toLowerCase()

  if (text.includes("HTTP Error 429") || lower.includes("too many requests")) {
    return "Platform membatasi request dari IP worker. Tunggu sebentar atau coba link lain."
  }

  if (lower.includes("sign in to confirm") || lower.includes("not a bot")) {
    return "Platform meminta verifikasi bot untuk link ini. Mode public gratis tidak memakai cookies login. Coba link lain atau direct media link."
  }

  if (lower.includes("unsupported url")) {
    return "Platform atau link belum didukung engine."
  }

  if (lower.includes("private") || lower.includes("login")) {
    return "Konten private atau butuh login tidak bisa diproses."
  }

  if (lower.includes("drm")) {
    return "Konten DRM atau konten terbatas tidak bisa diproses."
  }

  if (text.includes("Process timeout")) {
    return "Proses terlalu lama. Coba quality lebih rendah."
  }

  return text.slice(0, 260) || "Download gagal."
}

app.listen(PORT, () => {
  console.log(`MenGinaSV public worker running on port ${PORT}`)
})
