import express from "express"
import cors from "cors"
import helmet from "helmet"
import { nanoid } from "nanoid"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs"
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

if (!existsSync(downloadDir)) {
  mkdirSync(downloadDir, { recursive: true })
}

app.use(helmet({ crossOriginResourcePolicy: false }))
app.use(cors())
app.use(express.json({ limit: "1mb" }))

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service: "social-saver-worker",
    engine: "yt-dlp + ffmpeg + deno",
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

    if (mediaGroup === "video") {
      outputFile = await processVideo({ url, jobId, quality, fileType })
    }

    if (mediaGroup === "audio") {
      outputFile = await processAudio({ url, jobId, quality, fileType })
    }

    if (mediaGroup === "photo") {
      outputFile = await processPhoto({ url, jobId, quality, fileType })
    }

    if (!outputFile || !existsSync(outputFile)) {
      return res.status(422).json({
        ok: false,
        error: "File hasil tidak ditemukan."
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
    return res.status(422).json({
      ok: false,
      error: simplifyError(error?.message || "Download gagal.")
    })
  }
})


function ytDlpBaseArgs(outputTemplate) {
  return [
    "--no-playlist",
    "--restrict-filenames",
    "--windows-filenames",
    "--newline",
    "--retries", "3",
    "--fragment-retries", "3",
    "--sleep-requests", "1",
    "--sleep-interval", "1",
    "--max-sleep-interval", "3",
    "--js-runtimes", "deno",
    "--output", outputTemplate
  ]
}

async function processVideo({ url, jobId, quality, fileType }) {
  const sourceTemplate = join(downloadDir, `${jobId}-source.%(ext)s`)
  const maxHeight = parseVideoHeight(quality)
  const selector = maxHeight
    ? `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`
    : "bestvideo+bestaudio/best"

  await mustRun("yt-dlp", [
    ...ytDlpBaseArgs(sourceTemplate),
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

  const sourceExt = extname(source).replace(".", "").toLowerCase()
  const target = join(downloadDir, `${jobId}.${fileType}`)
  const bitrate = parseAudioBitrate(quality)

  if (sourceExt === fileType && quality === "best") {
    return source
  }

  await mustRun("ffmpeg", buildAudioConvertArgs(source, target, fileType, bitrate), 260000)
  safeRemove(source)

  return existsSync(target) ? target : null
}

async function processPhoto({ url, jobId, quality, fileType }) {
  const directImage = isDirectImage(url)

  if (directImage) {
    const ext = extname(new URL(url).pathname) || ".jpg"
    const source = join(downloadDir, `${jobId}-image${ext}`)
    await downloadDirectFile(url, source)
    return await convertImage(source, jobId, fileType)
  }

  const sourceTemplate = join(downloadDir, `${jobId}-photo.%(ext)s`)

  await mustRun("yt-dlp", [
    ...ytDlpBaseArgs(sourceTemplate),
    "--skip-download",
    "--write-thumbnail",
    url
  ], 220000)

  const source = findFile(`${jobId}-photo`)
  if (!source) return null

  return await convertImage(source, jobId, fileType)
}

async function convertImage(source, jobId, fileType) {
  const target = join(downloadDir, `${jobId}.${fileType}`)

  await mustRun("ffmpeg", [
    "-y",
    "-i", source,
    target
  ], 180000)

  safeRemove(source)
  return existsSync(target) ? target : null
}

function buildVideoConvertArgs(source, target, fileType) {
  const args = ["-y", "-i", source]

  if (fileType === "webm") {
    args.push("-c:v", "libvpx-vp9", "-c:a", "libopus")
  } else if (fileType === "flv") {
    args.push("-c:v", "flv", "-c:a", "mp3")
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

  if (bitrate) {
    args.push("-b:a", bitrate)
  }

  args.push(target)
  return args
}

function preferredYtDlpAudioFormat(fileType) {
  if (["mp3", "m4a", "aac", "wav", "flac", "opus"].includes(fileType)) return fileType
  if (fileType === "ogg") return "vorbis"
  return "best"
}

function mustRun(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: downloadDir,
      env: process.env
    })

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

      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(stderr || stdout || `Command failed: ${command}`))
      }
    })

    child.on("error", (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function downloadDirectFile(url, target) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error("Gagal mengambil file gambar langsung.")
  }

  const arrayBuffer = await response.arrayBuffer()
  writeFileSync(target, Buffer.from(arrayBuffer))
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
  return ["video", "audio", "photo"].includes(mediaGroup) ? mediaGroup : "video"
}

function normalizeFileType(value, mediaGroup) {
  const fileType = String(value || "").toLowerCase()
  const allowed = mediaGroup === "audio"
    ? AUDIO_TYPES
    : mediaGroup === "photo"
      ? PHOTO_TYPES
      : VIDEO_TYPES

  return allowed.includes(fileType) ? fileType : allowed[0]
}

function parseVideoHeight(quality) {
  const match = String(quality).match(/^(\d+)p$/)
  return match ? Number(match[1]) : null
}

function parseAudioBitrate(quality) {
  const match = String(quality).match(/^(\d+)k$/)
  return match ? `${match[1]}k` : null
}

function isDirectImage(value) {
  const clean = value.split("?")[0].toLowerCase()
  return clean.match(/\.(jpg|jpeg|png|webp|gif|bmp|tiff|avif)$/)
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
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "")
  }

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
      if (stats.isFile() && now - stats.mtimeMs > maxAge) {
        rmSync(filePath, { force: true })
      }
    } catch {
      // ignore cleanup error
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

function simplifyError(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim()

  if (text.includes("HTTP Error 429") || text.toLowerCase().includes("too many requests")) {
    return "YouTube membatasi request dari IP worker. Tunggu beberapa menit, coba quality lebih rendah, atau deploy worker di server/IP lain."
  }

  if (text.toLowerCase().includes("javascript runtime") || text.toLowerCase().includes("js runtime")) {
    return "Worker belum menemukan runtime JavaScript. Deploy ulang worker versi terbaru yang sudah memasang Deno."
  }

  if (text.includes("Unsupported URL")) {
    return "Platform atau link belum didukung oleh engine."
  }

  if (text.toLowerCase().includes("login") || text.toLowerCase().includes("private")) {
    return "Konten private atau butuh login tidak bisa diproses."
  }

  if (text.toLowerCase().includes("drm")) {
    return "Konten DRM atau konten terbatas tidak bisa diproses."
  }

  if (text.includes("Process timeout")) {
    return "Proses terlalu lama. Coba quality lebih rendah."
  }

  return text.slice(0, 240) || "Download gagal."
}

app.listen(PORT, () => {
  console.log(`Social Saver Worker running on port ${PORT}`)
})
