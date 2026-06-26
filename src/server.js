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

if (!existsSync(downloadDir)) {
  mkdirSync(downloadDir, { recursive: true })
}

app.use(helmet({ crossOriginResourcePolicy: false }))
app.use(cors())
app.use(express.json({ limit: "1mb" }))

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    mode: "cobalt-ready",
    service: "menginasv-worker",
    engine: "convert-warning guard + verified audio + cobalt + picker + local-processing + yt-dlp + ffmpeg + deno",
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

    const downloadBlockReason = getDownloadBlockReason(url)

    if (downloadBlockReason) {
      return res.status(422).json({
        ok: false,
        blocked: true,
        error: downloadBlockReason
      })
    }

    cleanupOldFiles()

    const audioOnlyPage = isAudioOnlyPageUrl(url)

    if (audioOnlyPage && mediaGroup !== "audio") {
      return res.status(422).json({
        ok: false,
        error: "Link ini terdeteksi sebagai musik/audio. Pilih tab Audio saja."
      })
    }

    const directType = detectDirectMedia(url)
    const jobId = nanoid(10)
    let outputFile = null

    if (audioOnlyPage && !directType) {
      const musicResult = await processMusicPage({
        req,
        originalUrl: url,
        quality,
        fileType,
        jobId
      })

      if (musicResult?.ok) {
        return res.json(musicResult)
      }

      if (musicResult?.outputFile) {
        outputFile = musicResult.outputFile
      }

      if (!outputFile) {
        return res.status(422).json({
          ok: false,
          error: "Resolver musik belum menemukan audio yang valid untuk link ini. Untuk TikTok Music, pakai link video yang memakai sound tersebut kalau sound page tetap gagal."
        })
      }
    }

    if (!audioOnlyPage) {
      const cobaltResult = await tryCobalt({
        req,
        url,
        mediaGroup,
        quality,
        fileType
      })

      if (cobaltResult?.ok) {
        return res.json(cobaltResult)
      }
    }

    if (!outputFile) {
      if (directType) {
        outputFile = await processDirectMedia({ url, jobId, mediaGroup, fileType })
      } else {
        outputFile = await processWithYtDlp({ url, jobId, mediaGroup, quality, fileType })
      }
    }

    if (!outputFile || !existsSync(outputFile)) {
      return res.status(422).json({
        ok: false,
        error: mediaGroup === "audio" ? "Audio valid tidak ditemukan. Worker sudah menolak file kosong. Coba link video/post yang memakai sound tersebut." : "Provider belum bisa memproses link ini. Coba tab lain, format lain, direct media link, atau ganti server Cobalt."
      })
    }

    const title = basename(outputFile)
    const downloadUrl = `${getPublicBase(req)}/files/${encodeURIComponent(title)}`

    return res.json({ ok: true, title, mediaGroup, quality, fileType, downloadUrl })
  } catch (error) {
    return res.status(422).json({
      ok: false,
      error: simplifyError(error?.message || "Download gagal.")
    })
  }
})

async function tryCobalt({ req, url, mediaGroup, quality, fileType }) {
  const baseUrl = process.env.COBALT_API_URL

  if (!baseUrl) {
    return null
  }

  try {
    const body = buildCobaltBody({ url, mediaGroup, quality, fileType })
    const response = await fetch(baseUrl.replace(/\/$/, "") + "/", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(process.env.COBALT_API_KEY ? { authorization: `Api-Key ${process.env.COBALT_API_KEY}` } : {})
      },
      body: JSON.stringify(body)
    })

    const data = await response.json().catch(() => null)

    if (!response.ok || !data) {
      return null
    }

    if (data.status === "error") {
      return null
    }

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

    if (data.status === "picker") {
      return await handleCobaltPicker({ req, data, mediaGroup, quality, fileType })
    }

    if (data.status === "local-processing") {
      return await handleCobaltLocalProcessing({
        req,
        data,
        mediaGroup,
        quality,
        fileType
      })
    }

    return null
  } catch {
    return null
  }
}

function buildCobaltBody({ url, mediaGroup, quality, fileType }) {
  const body = {
    url,
    filenameStyle: "basic",
    disableMetadata: false,
    alwaysProxy: true,
    localProcessing: "preferred"
  }

  if (mediaGroup === "audio") {
    body.downloadMode = "audio"
    body.audioFormat = mapCobaltAudioFormat(fileType)
    body.audioBitrate = parseCobaltAudioBitrate(quality)
    body.youtubeBetterAudio = true
    body.tiktokFullAudio = true
  } else if (mediaGroup === "video") {
    body.downloadMode = "auto"
    body.videoQuality = parseCobaltVideoQuality(quality)
    body.youtubeVideoContainer = mapCobaltVideoContainer(fileType)
    body.youtubeVideoCodec = "h264"
    body.allowH265 = true
    body.convertGif = true
  } else if (mediaGroup === "photo") {
    body.downloadMode = "auto"
    body.convertGif = true
  }

  return body
}

async function handleCobaltPicker({ req, data, mediaGroup, quality, fileType }) {
  if (mediaGroup === "audio" && data.audio) {
    return {
      ok: true,
      title: data.audioFilename || `audio-${Date.now()}.${fileType}`,
      mediaGroup,
      quality,
      fileType,
      downloadUrl: data.audio
    }
  }

  const items = Array.isArray(data.picker) ? data.picker : []
  const selected = selectPickerItem(items, mediaGroup)

  if (!selected?.url) {
    return null
  }

  if (mediaGroup === "audio") {
    return await processRemoteUrlAsAudio({
      req,
      sourceUrl: selected.url,
      quality,
      fileType,
      titlePrefix: "picker-audio"
    })
  }

  return {
    ok: true,
    title: selected.filename || `${selected.type || mediaGroup}-${Date.now()}.${fileType}`,
    mediaGroup,
    quality,
    fileType,
    downloadUrl: selected.url,
    thumb: selected.thumb || null
  }
}

function selectPickerItem(items, mediaGroup) {
  if (mediaGroup === "photo") {
    return items.find((item) => item.type === "photo") ||
      items.find((item) => item.type === "gif") ||
      items[0]
  }

  if (mediaGroup === "video") {
    return items.find((item) => item.type === "video") ||
      items.find((item) => item.type === "gif") ||
      items[0]
  }

  if (mediaGroup === "audio") {
    return items.find((item) => item.type === "video") ||
      items.find((item) => item.type === "gif") ||
      items[0]
  }

  return items[0]
}

async function handleCobaltLocalProcessing({ req, data, mediaGroup, quality, fileType }) {
  const tunnels = Array.isArray(data.tunnel) ? data.tunnel : []

  if (!tunnels.length) {
    return null
  }

  const jobId = nanoid(10)
  const outputFilename = sanitizeFilename(data.output?.filename || `menginasv-${jobId}.${fileType}`)
  const outputExt = extname(outputFilename).replace(".", "").toLowerCase()
  const finalExt = outputExt || fileType
  const outputFile = join(downloadDir, `${jobId}.${finalExt}`)

  if (tunnels.length === 1) {
    const sourceFile = join(downloadDir, `${jobId}-source${extname(outputFilename) || "." + fileType}`)
    await downloadDirectFile(tunnels[0], sourceFile)

    const currentExt = extname(sourceFile).replace(".", "").toLowerCase()

    if (isCompatibleExt(currentExt, fileType, mediaGroup)) {
      const publicUrl = `${getPublicBase(req)}/files/${encodeURIComponent(basename(sourceFile))}`
      return {
        ok: true,
        title: basename(sourceFile),
        mediaGroup,
        quality,
        fileType,
        downloadUrl: publicUrl
      }
    }

    const converted = await convertLocalFile({ sourceFile, targetExt: fileType, mediaGroup, quality, jobId })
    if (!converted) return null

    const publicUrl = `${getPublicBase(req)}/files/${encodeURIComponent(basename(converted))}`

    return {
      ok: true,
      title: basename(converted),
      mediaGroup,
      quality,
      fileType,
      downloadUrl: publicUrl
    }
  }

  const sourceFiles = []

  for (let i = 0; i < tunnels.length; i++) {
    const source = join(downloadDir, `${jobId}-part-${i}.bin`)
    await downloadDirectFile(tunnels[i], source)
    sourceFiles.push(source)
  }

  const target = join(downloadDir, `${jobId}.${fileType}`)
  await mergeCobaltParts({ sourceFiles, target, mediaGroup, fileType })

  for (const source of sourceFiles) {
    safeRemove(source)
  }

  if (!existsSync(target)) return null

  const publicUrl = `${getPublicBase(req)}/files/${encodeURIComponent(basename(target))}`

  return {
    ok: true,
    title: basename(target),
    mediaGroup,
    quality,
    fileType,
    downloadUrl: publicUrl
  }
}

async function mergeCobaltParts({ sourceFiles, target, mediaGroup, fileType }) {
  if (mediaGroup === "audio") {
    await mustRun("ffmpeg", [
      "-y",
      "-i", sourceFiles[0],
      ...sourceFiles.slice(1).flatMap((file) => ["-i", file]),
      ...buildAudioOutputArgs(fileType, null),
      target
    ], 260000)
    return
  }

  if (sourceFiles.length >= 2) {
    await mustRun("ffmpeg", [
      "-y",
      "-i", sourceFiles[0],
      "-i", sourceFiles[1],
      "-map", "0:v:0?",
      "-map", "1:a:0?",
      ...buildVideoOutputArgs(fileType),
      target
    ], 300000)
    return
  }

  await mustRun("ffmpeg", [
    "-y",
    "-i", sourceFiles[0],
    ...buildVideoOutputArgs(fileType),
    target
  ], 260000)
}

async function convertLocalFile({ sourceFile, targetExt, mediaGroup, quality, jobId }) {
  const target = join(downloadDir, `${jobId}.${targetExt}`)

  if (mediaGroup === "audio") {
    await mustRun("ffmpeg", [
      "-y",
      "-i", sourceFile,
      ...buildAudioOutputArgs(targetExt, parseAudioBitrate(quality)),
      target
    ], 260000)
  } else if (mediaGroup === "photo") {
    await mustRun("ffmpeg", ["-y", "-i", sourceFile, target], 180000)
  } else {
    await mustRun("ffmpeg", [
      "-y",
      "-i", sourceFile,
      ...buildVideoOutputArgs(targetExt),
      target
    ], 260000)
  }

  safeRemove(sourceFile)
  return existsSync(target) ? target : null
}

function isCompatibleExt(currentExt, targetExt, mediaGroup) {
  if (!currentExt || !targetExt) return false
  if (currentExt === targetExt) return true
  if (targetExt === "jpeg" && currentExt === "jpg") return true

  if (mediaGroup === "video" && targetExt === "mp4" && ["mp4", "m4v"].includes(currentExt)) return true
  if (mediaGroup === "audio" && targetExt === "mp3" && currentExt === "mp3") return true
  return false
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

async function processRemoteUrlAsAudio({ req, sourceUrl, quality, fileType, titlePrefix = "audio" }) {
  const jobId = nanoid(10)
  const sourceFile = join(downloadDir, `${jobId}-remote-source.bin`)

  try {
    await downloadDirectFile(sourceUrl, sourceFile)

    if (!(await hasUsableAudioTrack(sourceFile))) {
      safeRemove(sourceFile)
      return null
    }

    const target = join(downloadDir, `${jobId}.${fileType}`)
    await mustRun("ffmpeg", buildAudioConvertArgs(sourceFile, target, fileType, parseAudioBitrate(quality)), 260000)
    safeRemove(sourceFile)

    if (!(await hasUsableAudioTrack(target))) {
      safeRemove(target)
      return null
    }

    const publicUrl = `${getPublicBase(req)}/files/${encodeURIComponent(basename(target))}`

    return {
      ok: true,
      title: `${titlePrefix}-${Date.now()}.${fileType}`,
      mediaGroup: "audio",
      quality,
      fileType,
      downloadUrl: publicUrl
    }
  } catch {
    safeRemove(sourceFile)
    return null
  }
}

async function hasUsableAudioTrack(filePath) {
  if (!existsSync(filePath)) return false

  try {
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size < 2048) return false
  } catch {
    return false
  }

  try {
    const result = await runForOutput("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_type",
      "-show_entries", "format=duration",
      "-of", "json",
      filePath
    ], 60000)

    const parsed = JSON.parse(result.stdout || "{}")
    const hasAudio = Array.isArray(parsed.streams) && parsed.streams.some((stream) => stream.codec_type === "audio")
    const duration = Number(parsed.format?.duration || 0)

    return hasAudio && duration > 0.2
  } catch {
    return false
  }
}

function runForOutput(command, args, timeoutMs) {
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

    child.stdout.on("data", chunk => { stdout += chunk.toString() })
    child.stderr.on("data", chunk => { stderr += chunk.toString() })

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
    if (currentExt === fileType && await hasUsableAudioTrack(sourceFile)) return sourceFile

    const target = join(downloadDir, `${jobId}.${fileType}`)
    await mustRun("ffmpeg", buildAudioConvertArgs(sourceFile, target, fileType, null), 240000)
    safeRemove(sourceFile)

    if (!existsSync(target) || !(await hasUsableAudioTrack(target))) {
      safeRemove(target)
      return null
    }

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
  if (currentExt === fileType && quality === "best" && await hasUsableAudioTrack(source)) return source

  const target = join(downloadDir, `${jobId}.${fileType}`)
  const bitrate = parseAudioBitrate(quality)
  await mustRun("ffmpeg", buildAudioConvertArgs(source, target, fileType, bitrate), 260000)
  safeRemove(source)

  if (!existsSync(target) || !(await hasUsableAudioTrack(target))) {
    safeRemove(target)
    return null
  }

  return target
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
  return [
    "-y",
    "-i", source,
    ...buildVideoOutputArgs(fileType),
    target
  ]
}

function buildVideoOutputArgs(fileType) {
  if (fileType === "webm") return ["-c:v", "libvpx-vp9", "-c:a", "libopus"]
  if (fileType === "flv") return ["-c:v", "flv", "-c:a", "mp3"]
  if (fileType === "3gp") return ["-s", "352x288", "-c:v", "h263", "-c:a", "aac"]
  return ["-c:v", "libx264", "-c:a", "aac"]
}

function buildAudioConvertArgs(source, target, fileType, bitrate) {
  return [
    "-y",
    "-i", source,
    ...buildAudioOutputArgs(fileType, bitrate),
    target
  ]
}

function buildAudioOutputArgs(fileType, bitrate) {
  const args = []

  if (fileType === "mp3") args.push("-codec:a", "libmp3lame")
  if (fileType === "m4a" || fileType === "aac") args.push("-codec:a", "aac")
  if (fileType === "wav") args.push("-codec:a", "pcm_s16le")
  if (fileType === "flac") args.push("-codec:a", "flac")
  if (fileType === "ogg") args.push("-codec:a", "libvorbis")
  if (fileType === "opus" || fileType === "webm") args.push("-codec:a", "libopus")

  if (bitrate && fileType !== "wav" && fileType !== "flac") args.push("-b:a", bitrate)

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

    child.stdout.on("data", chunk => { stdout += chunk.toString() })
    child.stderr.on("data", chunk => { stderr += chunk.toString() })

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

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  )
}


function isAudioOnlyPageUrl(value) {
  return isTikTokMusicUrl(value) ||
    isYouTubeMusicUrl(value) ||
    isSoundCloudUrl(value) ||
    isInstagramAudioUrl(value) ||
    isSpotifyUrl(value) ||
    isAppleMusicUrl(value)
}

function isTikTokMusicUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.hostname.includes("tiktok.com") && parsed.pathname.includes("/music/")
  } catch {
    return false
  }
}

function isYouTubeMusicUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.hostname.includes("music.youtube.com")
  } catch {
    return false
  }
}

function isSoundCloudUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.hostname.includes("soundcloud.com")
  } catch {
    return false
  }
}

function isInstagramAudioUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.hostname.includes("instagram.com") &&
      (parsed.pathname.includes("/reels/audio/") || parsed.pathname.includes("/audio/"))
  } catch {
    return false
  }
}

function isSpotifyUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.hostname.includes("spotify.com")
  } catch {
    return false
  }
}

function isAppleMusicUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.hostname.includes("music.apple.com")
  } catch {
    return false
  }
}

async function processMusicPage({ req, originalUrl, quality, fileType, jobId }) {
  const normalizedUrl = normalizeMusicUrl(originalUrl)
  const candidateUrls = await resolveMusicCandidates(normalizedUrl)

  for (const candidateUrl of candidateUrls) {
    const directType = detectDirectMedia(candidateUrl)

    try {
      if (directType) {
        const outputFile = await processDirectMedia({
          url: candidateUrl,
          jobId: `${jobId}-music`,
          mediaGroup: "audio",
          fileType
        })

        if (outputFile && await hasUsableAudioTrack(outputFile)) return { outputFile }
        if (outputFile) safeRemove(outputFile)
      }

      if (!isNonDownloadableMusicPage(candidateUrl)) {
        const outputFile = await processWithYtDlp({
          url: candidateUrl,
          jobId: `${jobId}-music`,
          mediaGroup: "audio",
          quality,
          fileType
        })

        if (outputFile && await hasUsableAudioTrack(outputFile)) return { outputFile }
        if (outputFile) safeRemove(outputFile)
      }
    } catch {
      // Try Cobalt below.
    }

    const cobaltResult = await tryCobalt({
      req,
      url: candidateUrl,
      mediaGroup: "audio",
      quality,
      fileType
    })

    if (cobaltResult?.ok && cobaltResult.downloadUrl) {
      const verified = await processRemoteUrlAsAudio({
        req,
        sourceUrl: cobaltResult.downloadUrl,
        quality,
        fileType,
        titlePrefix: "music-cobalt"
      })

      if (verified?.ok) return verified
    }
  }

  return null
}

function normalizeMusicUrl(value) {
  if (isYouTubeMusicUrl(value)) {
    try {
      const parsed = new URL(value)
      const videoId = parsed.searchParams.get("v")
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`
    } catch {
      return value
    }
  }

  return value
}

function isNonDownloadableMusicPage(value) {
  return isSpotifyUrl(value) || isAppleMusicUrl(value)
}

async function resolveMusicCandidates(value) {
  const candidates = []
  const normalized = normalizeMusicUrl(value)

  if (isYouTubeMusicUrl(value) || isSoundCloudUrl(value)) {
    addCandidate(candidates, normalized)
  }

  const externalCandidates = await resolveWithExternalMusicApi(normalized)
  for (const item of externalCandidates) addCandidate(candidates, item)

  if (isTikTokMusicUrl(normalized)) {
    const tiktokCandidates = await resolveTikTokMusicCandidates(normalized)
    for (const item of tiktokCandidates) addCandidate(candidates, item)
  }

  if (isInstagramAudioUrl(normalized)) {
    const instagramCandidates = await resolveInstagramAudioCandidates(normalized)
    for (const item of instagramCandidates) addCandidate(candidates, item)
  }

  if (!isTikTokMusicUrl(value) && !isInstagramAudioUrl(value) && !isSpotifyUrl(value) && !isAppleMusicUrl(value)) {
    addCandidate(candidates, normalized)
  }

  return candidates
}

function addCandidate(candidates, value) {
  if (!value) return
  if (!candidates.includes(value)) candidates.push(value)
}

async function resolveWithExternalMusicApi(value) {
  const apiUrl = process.env.MUSIC_RESOLVER_API_URL
  if (!apiUrl) return []

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MUSIC_RESOLVER_API_KEY ? { authorization: `Bearer ${process.env.MUSIC_RESOLVER_API_KEY}` } : {})
      },
      body: JSON.stringify({ url: value })
    })

    const data = await response.json().catch(() => null)

    if (!response.ok || !data) return []

    if (typeof data.url === "string") return [data.url]
    if (Array.isArray(data.urls)) return data.urls.filter((item) => typeof item === "string")
    if (typeof data.audioUrl === "string") return [data.audioUrl]
    if (Array.isArray(data.audioUrls)) return data.audioUrls.filter((item) => typeof item === "string")

    return []
  } catch {
    return []
  }
}

async function resolveTikTokMusicCandidates(value) {
  const candidates = []
  const musicId = extractTikTokMusicId(value)

  if (musicId) {
    const apiCandidates = await resolveTikTokMusicFromApi(value, musicId)
    for (const item of apiCandidates) addCandidate(candidates, item)
  }

  const htmlCandidates = await resolveTikTokMusicFromHtml(value)
  for (const item of htmlCandidates) addCandidate(candidates, item)

  return candidates
}

function extractTikTokMusicId(value) {
  try {
    const parsed = new URL(value)
    const match = parsed.pathname.match(/-(\d+)(?:\/)?$/)
    return match?.[1] || null
  } catch {
    return null
  }
}

async function resolveTikTokMusicFromApi(originalUrl, musicId) {
  const candidates = []

  const apiUrl = new URL("https://www.tiktok.com/api/music/item_list/")
  const params = {
    WebIdLastTime: String(Math.floor(Date.now() / 1000)),
    aid: "1988",
    app_language: "en",
    app_name: "tiktok_web",
    browser_language: "en-US",
    browser_name: "Mozilla",
    browser_online: "true",
    browser_platform: "Win32",
    browser_version: "5.0",
    channel: "tiktok_web",
    cookie_enabled: "true",
    count: "6",
    cursor: "0",
    device_platform: "web_pc",
    focus_state: "true",
    from_page: "music",
    history_len: "1",
    is_fullscreen: "false",
    is_page_visible: "true",
    musicID: musicId,
    os: "windows",
    priority_region: "",
    referer: "",
    region: "US",
    screen_height: "1080",
    screen_width: "1920",
    tz_name: "UTC",
    webcast_language: "en"
  }

  for (const [key, value] of Object.entries(params)) {
    apiUrl.searchParams.set(key, value)
  }

  try {
    const response = await fetch(apiUrl.toString(), {
      redirect: "follow",
      headers: browserHeaders(originalUrl)
    })

    if (!response.ok) return candidates

    const data = await response.json().catch(() => null)
    const items = data?.itemList || data?.items || []

    for (const item of items) {
      const author = item?.author?.uniqueId || item?.authorInfo?.uniqueId
      const id = item?.id || item?.aweme_id || item?.video?.id

      if (author && id) {
        addCandidate(candidates, `https://www.tiktok.com/@${author}/video/${id}`)
      }

      const playUrl = item?.music?.playUrl || item?.music?.play_url?.uri || item?.music?.play_url?.url_list?.[0]
      if (playUrl) addCandidate(candidates, playUrl)
    }

    return candidates
  } catch {
    return candidates
  }
}

async function resolveTikTokMusicFromHtml(value) {
  const candidates = []

  try {
    const response = await fetch(value, {
      redirect: "follow",
      headers: browserHeaders(value)
    })

    if (!response.ok) return candidates

    const html = await response.text()
    const normalizedHtml = html
      .replaceAll("\\u002F", "/")
      .replaceAll("\\/", "/")
      .replaceAll("&amp;", "&")

    collectMatches(candidates, normalizedHtml, /https:\/\/www\.tiktok\.com\/@[^"'<>\s]+\/video\/\d+/g)
    collectMatches(candidates, normalizedHtml, /\/@[^"'<>\s]+\/video\/\d+/g, "https://www.tiktok.com")
    collectMatches(candidates, normalizedHtml, /https:\/\/[^"'<>\s]+\.tiktokcdn\.com\/[^"'<>\s]+/g)

    return candidates
  } catch {
    return candidates
  }
}

async function resolveInstagramAudioCandidates(value) {
  const candidates = []

  try {
    const response = await fetch(value, {
      redirect: "follow",
      headers: browserHeaders(value)
    })

    if (!response.ok) return candidates

    const html = await response.text()
    const normalizedHtml = html
      .replaceAll("\\u002F", "/")
      .replaceAll("\\/", "/")
      .replaceAll("&amp;", "&")

    collectMatches(candidates, normalizedHtml, /https:\/\/www\.instagram\.com\/reel\/[^"'<>\\s/]+\/?/g)
    collectMatches(candidates, normalizedHtml, /\/reel\/[^"'<>\\s/]+\/?/g, "https://www.instagram.com")
    collectMatches(candidates, normalizedHtml, /https:\/\/[^"'<>\\s]+\.cdninstagram\.com\/[^"'<>\\s]+/g)

    return candidates
  } catch {
    return candidates
  }
}

function collectMatches(candidates, text, regex, prefix = "") {
  const matches = text.matchAll(regex)
  for (const match of matches) {
    const value = match?.[0]
    if (value) addCandidate(candidates, prefix ? `${prefix}${value}` : value)
  }
}

function browserHeaders(referer) {
  return {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "accept-language": "en-US,en;q=0.9,id;q=0.8",
    "referer": referer,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  }
}

function getDownloadBlockReason(value) {
  if (isTikTokMusicUrl(value)) {
    return "Link TikTok Music/Sound belum bisa diunduh langsung. Buka sound tersebut, pilih salah satu video yang memakai sound itu, lalu paste link videonya dan pilih tab Audio."
  }

  if (isInstagramAudioUrl(value)) {
    return "Link halaman audio Instagram belum bisa diunduh langsung. Pakai link Reel/Post yang memakai audio tersebut, lalu pilih tab Audio."
  }

  if (isSpotifyUrl(value)) {
    return "Spotify tidak didukung untuk download langsung karena butuh login/DRM. Gunakan link audio publik lain atau direct MP3."
  }

  if (isAppleMusicUrl(value)) {
    return "Apple Music tidak didukung untuk download langsung karena butuh login/DRM. Gunakan link audio publik lain atau direct MP3."
  }

  if (isYouTubeMusicUrl(value) && !getYouTubeVideoId(value)) {
    return "Link YouTube Music ini tidak punya video ID yang bisa diproses. Pakai link lagu yang ada parameter v= atau link YouTube video biasa."
  }

  return null
}

function getYouTubeVideoId(value) {
  try {
    const parsed = new URL(value)
    if (parsed.hostname.includes("youtu.be")) return parsed.pathname.replace("/", "").split("?")[0] || null
    if (parsed.hostname.includes("youtube.com")) {
      if (parsed.searchParams.get("v")) return parsed.searchParams.get("v")
      const shortsMatch = parsed.pathname.match(/\/shorts\/([^/?]+)/)
      if (shortsMatch) return shortsMatch[1]
      const embedMatch = parsed.pathname.match(/\/embed\/([^/?]+)/)
      if (embedMatch) return embedMatch[1]
    }
    return null
  } catch {
    return null
  }
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

function sanitizeFilename(value) {
  return String(value || "menginasv-file")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .slice(0, 160)
}

function simplifyError(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim()
  const lower = text.toLowerCase()

  if (text.includes("HTTP Error 429") || lower.includes("too many requests")) {
    return "Platform membatasi request dari IP worker/provider. Coba lagi nanti atau ganti provider Cobalt."
  }

  if (lower.includes("sign in to confirm") || lower.includes("not a bot")) {
    return "Platform meminta verifikasi bot untuk link ini. Coba pakai Cobalt di server lain atau coba link lain."
  }

  if (lower.includes("no working app info") || lower.includes("functionality for this site has been marked as broken")) {
    return "Resolver musik belum menemukan sumber audio untuk link ini. Coba ulangi beberapa saat lagi atau pakai link video/post yang memakai musik tersebut."
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
  console.log(`MgreSV type-aware music worker running on port ${PORT}`)
})
