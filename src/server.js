import express from "express"
import cors from "cors"
import helmet from "helmet"
import { nanoid } from "nanoid"
import { spawn } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
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

if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true })

app.use(helmet({ crossOriginResourcePolicy: false }))
app.use(cors())
app.use(express.json({ limit: "1mb" }))

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    mode: "cobalt-ready",
    service: "menginasv-worker",
    engine: "cobalt-api + direct-file + yt-dlp + ffmpeg + deno",
    cobaltEnabled: Boolean(process.env.COBALT_API_URL),
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
      return res.status(429).json({ ok: false, error: "Terlalu banyak request. Tunggu sebentar lalu coba lagi." })
    }

    const url = normalizeUrl(req.body?.url)
    const mediaGroup = normalizeMediaGroup(req.body?.mediaGroup)
    const quality = String(req.body?.quality || "best").toLowerCase()
    const fileType = normalizeFileType(req.body?.fileType, mediaGroup)

    if (!url) return res.status(400).json({ ok: false, error: "URL tidak valid." })

    cleanupOldFiles()

    const cobaltResult = await tryCobalt({ url, mediaGroup, quality, fileType })
    if (cobaltResult?.ok) return res.json(cobaltResult)

    const directType = detectDirectMedia(url)
    const jobId = nanoid(10)
    let outputFile = null

    if (directType) {
      outputFile = await processDirectMedia({ url, jobId, mediaGroup, fileType })
    } else {
      outputFile = await processWithYtDlp({ url, jobId, mediaGroup, quality, fileType })
    }

    if (!outputFile || !existsSync(outputFile)) {
      return res.status(422).json({
        ok: false,
        error: "Provider belum bisa memproses link ini. Coba direct media link, provider Cobalt lain, atau link lain."
      })
    }

    const title = basename(outputFile)
    const downloadUrl = `${getPublicBase(req)}/files/${encodeURIComponent(title)}`

    return res.json({ ok: true, title, mediaGroup, quality, fileType, downloadUrl })
  } catch (error) {
    return res.status(422).json({ ok: false, error: simplifyError(error?.message || "Download gagal.") })
  }
})

async function tryCobalt({ url, mediaGroup, quality, fileType }) {
  const baseUrl = process.env.COBALT_API_URL
  if (!baseUrl) return null

  try {
    const body = {
      url,
      filenameStyle: "basic",
      disableMetadata: false,
      alwaysProxy: true
    }

    if (mediaGroup === "audio") {
      body.downloadMode = "audio"
      body.audioFormat = mapCobaltAudioFormat(fileType)
      body.audioBitrate = parseCobaltAudioBitrate(quality)
    } else if (mediaGroup === "video") {
      body.downloadMode = "auto"
      body.videoQuality = parseCobaltVideoQuality(quality)
      body.youtubeVideoContainer = mapCobaltVideoContainer(fileType)
      body.youtubeVideoCodec = "h264"
    } else if (mediaGroup === "photo") {
      body.downloadMode = "auto"
    }

    const response = await fetch(baseUrl.replace(/\/$/, "") + "/", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        ...(process.env.COBALT_API_KEY ? { authorization: `Api-Key ${process.env.COBALT_API_KEY}` } : {})
      },
      body: JSON.stringify(body)
    })

    const data = await response.json().catch(() => null)

    if (!response.ok || !data) return null

    if (data.status === "redirect" || data.status === "tunnel") {
      return {
        ok: true,
        title: data.filename || `menginasv-${Date.now()}.${fileType}`,
        mediaGroup,
        quality,
        fileType,
        downloadUrl: data.url
      }
    }

    if (data.status === "picker" && Array.isArray(data.picker) && data.picker[0]?.url) {
      return {
        ok: true,
        title: data.picker[0].filename || `menginasv-${Date.now()}.${fileType}`,
        mediaGroup,
        quality,
        fileType,
        downloadUrl: data.picker[0].url
      }
    }

    return null
  } catch {
    return null
  }
}

function mapCobaltAudioFormat(fileType) {
  if (["mp3", "ogg", "wav", "opus"].includes(fileType)) return fileType
  return "mp3"
}

function parseCobaltAudioBitrate(quality) {
  const match = String(quality).match(/^(\d+)k$/)
  const value = match ? match[1] : "128"
  return ["320", "256", "128", "96", "64", "8"].includes(value) ? value : "128"
}

function parseCobaltVideoQuality(quality) {
  if (quality === "best") return "max"
  const match = String(quality).match(/^(\d+)p$/)
  const value = match ? match[1] : "1080"
  return ["4320", "2160", "1440", "1080", "720", "480", "360", "240", "144"].includes(value) ? value : "1080"
}

function mapCobaltVideoContainer(fileType) {
  if (["mp4", "webm", "mkv"].includes(fileType)) return fileType
  return "auto"
}

async function processDirectMedia({ url, jobId, mediaGroup, fileType }) {
  const parsed = new URL(url)
  const sourceExt = extname(parsed.pathname).replace(".", "").toLowerCase() || fileType
  const sourceFile = join(downloadDir, `${jobId}-source.${sourceExt}`)

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
    const currentExt = extname(sourceFile).replace(".", "").toLowerCase()
    if (currentExt === fileType) return sourceFile
    const target = join(downloadDir, `${jobId}.${fileType}`)
    await mustRun("ffmpeg", buildAudioConvertArgs(sourceFile, target, fileType, null), 240000)
    safeRemove(sourceFile)
    return target
  }

  if (mediaGroup === "photo") {
    const currentExt = extname(sourceFile).replace(".", "").toLowerCase()
    if (currentExt === fileType || (fileType === "jpeg" && currentExt === "jpg")) return sourceFile
    const target = join(downloadDir, `${jobId}.${fileType}`)
    await mustRun("ffmpeg", ["-y", "-i", sourceFile, target], 180000)
    safeRemove(sourceFile)
    return target
  }

  return null
}

async function processWithYtDlp({ url, jobId, mediaGroup, quality, fileType }) {
  if (mediaGroup === "video") return await processVideo({ url, jobId, quality, fileType })
  if (mediaGroup === "audio") return await processAudio({ url, jobId, quality, fileType })
  if (mediaGroup === "photo") return await processPhoto({ url, jobId, fileType })
  return null
}

async function processVideo({ url, jobId, quality, fileType }) {
  const sourceTemplate = join(downloadDir, `${jobId}-source.%(ext)s`)
  const maxHeight = parseVideoHeight(quality)
  const selector = maxHeight ? `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best` : "bestvideo+bestaudio/best"

  await mustRun("yt-dlp", [
    ...ytDlpBaseArgs(sourceTemplate),
    "--format", selector,
    "--merge-output-format", "mp4",
    url
  ], 300000)

  const source = findFile(`${jobId}-source`)
  if (!source) return null
  const currentExt = extname(source).replace(".", "").toLowerCase()
  if (currentExt === fileType) return source

  const target = join(downloadDir, `${jobId}.${fileType}`)
  await mustRun("ffmpeg", buildVideoConvertArgs(source, target, fileType), 260000)
  safeRemove(source)
  return existsSync(target) ? target : null
}

async function processAudio({ url, jobId, quality, fileType }) {
  const sourceTemplate = join(downloadDir, `${jobId}-audio.%(ext)s`)

  await mustRun("yt-dlp", [
    ...ytDlpBaseArgs(sourceTemplate),
    "--extract-audio",
    "--audio-format", preferredYtDlpAudioFormat(fileType),
    "--audio-quality", "0",
    url
  ], 300000)

  const source = findFile(`${jobId}-audio`)
  if (!source) return null
  const currentExt = extname(source).replace(".", "").toLowerCase()
  if (currentExt === fileType && quality === "best") return source

  const target = join(downloadDir, `${jobId}.${fileType}`)
  const bitrate = parseAudioBitrate(quality)
  await mustRun("ffmpeg", buildAudioConvertArgs(source, target, fileType, bitrate), 260000)
  safeRemove(source)
  return existsSync(target) ? target : null
}

async function processPhoto({ url, jobId, fileType }) {
  const sourceTemplate = join(downloadDir, `${jobId}-photo.%(ext)s`)

  await mustRun("yt-dlp", [
    ...ytDlpBaseArgs(sourceTemplate),
    "--skip-download",
    "--write-thumbnail",
    "--convert-thumbnails", fileType === "jpeg" ? "jpg" : fileType,
    url
  ], 220000)

  const source = findFile(`${jobId}-photo`)
  if (!source) return null
  const currentExt = extname(source).replace(".", "").toLowerCase()
  if (currentExt === fileType || (fileType === "jpeg" && currentExt === "jpg")) return source

  const target = join(downloadDir, `${jobId}.${fileType}`)
  await mustRun("ffmpeg", ["-y", "-i", source, target], 180000)
  safeRemove(source)
  return existsSync(target) ? target : null
}

function ytDlpBaseArgs(outputTemplate) {
  return [
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
}

function buildVideoConvertArgs(source, target, fileType) {
  const args = ["-y", "-i", source]
  if (fileType === "webm") args.push("-c:v", "libvpx-vp9", "-c:a", "libopus")
  else if (fileType === "flv") args.push("-c:v", "flv", "-c:a", "mp3")
  else if (fileType === "3gp") args.push("-s", "352x288", "-c:v", "h263", "-c:a", "aac")
  else args.push("-c:v", "libx264", "-c:a", "aac")
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
  if (fileType === "opus" || fileType === "webm") args.push("-codec:a", "libopus")
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
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 Chrome/120 Safari/537.36" } })
  if (!response.ok || !response.body) throw new Error("Direct file tidak bisa diambil.")

  await new Promise((resolve, reject) => {
    const fileStream = createWriteStream(target)
    response.body.pipeTo(new WritableStream({
      write(chunk) { fileStream.write(Buffer.from(chunk)) },
      close() { fileStream.end(); resolve() },
      abort(error) { fileStream.destroy(); reject(error) }
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

    child.stdout.on("data", chunk => stdout += chunk.toString())
    child.stderr.on("data", chunk => stderr += chunk.toString())

    child.on("close", code => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || stdout || `Command failed: ${command}`))
    })

    child.on("error", error => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(error)
    })
  })
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
  return host === "localhost" || host === "127.0.0.1" || host.startsWith("10.") || host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
}

function normalizeMediaGroup(value) {
  const mediaGroup = String(value || "video").toLowerCase()
  return ["video", "audio", "photo"].includes(mediaGroup) ? mediaGroup : "video"
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
  return readdirSync(downloadDir)
    .filter(file => file.startsWith(prefix + ".") || file.startsWith(prefix + "-"))
    .map(file => join(downloadDir, file))
    .filter(filePath => statSync(filePath).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || null
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
    } catch {}
  }
}

function safeRemove(filePath) {
  try { rmSync(filePath, { force: true }) } catch {}
}

function allowRequest(key) {
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE || 20)
  const now = Date.now()
  const windowMs = 60000
  const current = rateStore.get(key) || []
  const fresh = current.filter(timestamp => now - timestamp < windowMs)
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
  if (text.includes("HTTP Error 429") || lower.includes("too many requests")) return "Platform membatasi request dari IP worker/provider. Coba lagi nanti atau ganti provider Cobalt."
  if (lower.includes("sign in to confirm") || lower.includes("not a bot")) return "Platform meminta verifikasi bot untuk link ini. Gunakan Cobalt instance yang stabil atau coba link lain."
  if (lower.includes("unsupported url")) return "Platform atau link belum didukung engine."
  if (lower.includes("private") || lower.includes("login")) return "Konten private atau butuh login tidak bisa diproses."
  if (lower.includes("drm")) return "Konten DRM atau konten terbatas tidak bisa diproses."
  if (text.includes("Process timeout")) return "Proses terlalu lama. Coba quality lebih rendah."
  return text.slice(0, 260) || "Download gagal."
}

app.listen(PORT, () => {
  console.log(`MenGinaSV Cobalt-ready worker running on port ${PORT}`)
})
