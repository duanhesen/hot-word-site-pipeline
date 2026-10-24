// 素材管线：把 content/media/src 里的视频处理成「首帧封面 + 主色 + 时长」，
// 上传到 R2，并生成 src/config/media.ts 清单。站点只读清单，不做任何运行时生成。
//
//   node scripts/media-pipeline.mjs              # 只处理，不上传
//   node scripts/media-pipeline.mjs --upload     # 处理 + 上传到 R2
//
// 需要：Playwright 的 Chromium（已在 devDependencies），以及已登录的 wrangler。
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const SRC = 'content/media/src'
const OUT = 'content/media/out'
const BUCKET = process.env.MEDIA_BUCKET ?? 'moon-hop-media'
const PREFIX = process.env.MEDIA_PREFIX ?? 'clips'
const UPLOAD = process.argv.includes('--upload')

mkdirSync(OUT, { recursive: true })
const files = readdirSync(SRC).filter((f) => /\.(mp4|mov|webm)$/i.test(f)).sort()
if (!files.length) {
  console.error(`没有找到素材，把 mp4 放进 ${SRC}/`)
  process.exit(1)
}

// 用本地 http 服务喂素材：file:// 在 about:blank 里既不能解码也不能读 canvas
const TYPES = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' }
const server = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '/').slice(1))
  try {
    const body = readFileSync(join(SRC, name))
    res.writeHead(200, { 'content-type': TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream', 'content-length': body.length })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(4599, '127.0.0.1', resolve))

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('http://127.0.0.1:4599/')

const clips = []
for (const file of files) {
  const id = basename(file, extname(file))
  const src = `http://127.0.0.1:4599/${encodeURIComponent(file)}`

  const meta = await page.evaluate(async ({ src }) => {
    const video = document.createElement('video')
    video.src = src
    video.muted = true
    video.playsInline = true
    document.body.appendChild(video)
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve
      video.onerror = () => reject(new Error('video load failed'))
      setTimeout(() => reject(new Error('timeout')), 20000)
    })
    // 取 1 秒处（或视频中间）作为封面
    const at = Math.min(1, (video.duration || 2) / 2)
    await new Promise((resolve) => {
      video.onseeked = resolve
      video.currentTime = at
      setTimeout(resolve, 4000)
    })
    const w = video.videoWidth
    const h = video.videoHeight
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    let r = 0, g = 0, b = 0
    for (let i = 0; i < data.length; i += 4 * 97) {
      r += data[i]; g += data[i + 1]; b += data[i + 2]
    }
    const n = Math.ceil(data.length / (4 * 97))
    const tint = '#' + [r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('')
    // 封面缩到 720 宽，webp 编码
    const target = Math.min(720, w)
    const small = document.createElement('canvas')
    small.width = target
    small.height = Math.round((h / w) * target)
    small.getContext('2d').drawImage(video, 0, 0, small.width, small.height)
    return {
      duration: Math.round(video.duration * 10) / 10,
      width: w,
      height: h,
      tint,
      poster: small.toDataURL('image/webp', 0.82),
    }
  }, { src })

  const posterName = `${id}.webp`
  writeFileSync(join(OUT, posterName), Buffer.from(meta.poster.split(',')[1], 'base64'))
  clips.push({
    id,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    tint: meta.tint,
    posterFile: posterName,
  })
  console.log(`✓ ${id}  ${meta.width}x${meta.height}  ${meta.duration}s  ${meta.tint}`)
}
await browser.close()
server.close()

if (UPLOAD) {
  for (const clip of clips) {
    const video = `${clip.id}${extname(files.find((f) => basename(f, extname(f)) === clip.id) ?? '.mp4')}`
    const target = [
      [`${BUCKET}/${PREFIX}/${video}`, join(SRC, video), 'video/mp4'],
      [`${BUCKET}/${PREFIX}/${clip.posterFile}`, join(OUT, clip.posterFile), 'image/webp'],
    ]
    for (const [key, file, type] of target) {
      for (const mode of ['--remote', '--local']) {
        try {
          execFileSync('npx', ['wrangler', 'r2', 'object', 'put', key, mode, '--file', file, '--content-type', type], {
            stdio: ['ignore', 'ignore', 'ignore'],
          })
        } catch {
          console.warn(`  ${mode} 上传失败：${key}`)
        }
      }
      console.log(`↑ ${key} (remote + local)`)
    }
  }
}

const lines = [
  '// 由 scripts/media-pipeline.mjs 生成，不要手改。',
  '// 视频在 R2 的 ' + PREFIX + '/ 下，封面是同目录的 webp；站点只读这份清单。',
  'export type MediaClip = {',
  '  id: string',
  '  video: string',
  '  poster: string',
  '  tint: string',
  '  duration: number',
  '}',
  '',
  'export const MEDIA_CLIPS: readonly MediaClip[] = [',
  ...clips.map(
    (c) =>
      `  { id: '${c.id}', video: '/media/${PREFIX}/${c.id}.mp4', poster: '/media/${PREFIX}/${c.posterFile}', tint: '${c.tint}', duration: ${c.duration} },`,
  ),
  ']',
  '',
  '/** 按 id 取素材；找不到返回 null，调用方负责跳过 */',
  'export function mediaClip(id: string): MediaClip | null {',
  '  return MEDIA_CLIPS.find((c) => c.id === id) ?? null',
  '}',
  '',
].join('\n')
writeFileSync('src/config/media.ts', lines)
console.log(`\n已写入 src/config/media.ts（${clips.length} 条）`)
if (!UPLOAD) console.log('加 --upload 上传到 R2；上传后 /media/' + PREFIX + '/<id>.mp4 可直接访问')
