import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import type { ImageAttachment } from '../shared/types'

/**
 * 图片上传:集成 knowledge 仓库里的 `cos-image-upload` skill(腾讯云 COS)。
 *
 * **这是临时集成** —— 直接调用 skill 目录里的 `cos_upload.py`(纯标准库,无需
 * COS SDK),凭证由脚本自己从同目录的 cos_config.json 读,主进程不碰、不打印密钥。
 *
 * skill 脚本目录通过环境变量 `COS_SKILL_SCRIPTS` 覆盖,默认指向本机那份:
 *   /Users/stackwar/work/jst/knowledge/.kiro/skills/cos-image-upload/scripts
 *
 * 以脚本目录作为 cwd 启动,脚本的配置查找顺序就能命中旁边的 cos_config.json。
 */

/** 开发态的后备路径(本机 knowledge 仓库里的 skill)。打包后用内置的 resources/cos-upload。 */
const DEV_FALLBACK_DIR =
  '/Users/stackwar/work/jst/knowledge/.kiro/skills/cos-image-upload/scripts'

/** 上传超时:大图 + 网络,给足 60s */
const UPLOAD_TIMEOUT_MS = 60_000

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

/**
 * 上传脚本目录。优先级:
 * 1. 环境变量 COS_SKILL_SCRIPTS(显式覆盖)
 * 2. 打包内置:<resources>/cos-upload(electron-builder extraResources 放进来的)
 * 3. 开发态后备:本机 knowledge 仓库里的 skill
 * 这样分发出去的安装包自带上传脚本,无需用户另装。
 */
function scriptsDir(): string {
  if (process.env.COS_SKILL_SCRIPTS) return process.env.COS_SKILL_SCRIPTS
  const bundled = join(process.resourcesPath, 'cos-upload')
  if (app.isPackaged || existsSync(join(bundled, 'cos_upload.py'))) return bundled
  return DEV_FALLBACK_DIR
}

/** 上传脚本是否就位。缺失时(例如脚本未打进包)直接跳过,
 *  让渲染层回退到本地图片(base64/缩略图),而不是反复 spawn 报错。 */
function scriptPath(): string {
  return join(scriptsDir(), 'cos_upload.py')
}

export function isAvailable(): boolean {
  return existsSync(scriptPath())
}

function pythonBin(): string {
  return process.env.PYTHON_BIN || 'python3'
}

/**
 * 把一张图片(base64)上传到 COS,返回公网 URL。
 *
 * 做法:base64 落到临时文件 → 调 cos_upload.py <file> → 取 stdout 末行的 URL →
 * 无论成败都清掉临时文件。脚本内部已重试 3 次,这里不再重试。
 */
export async function uploadImage(image: ImageAttachment): Promise<{ url: string }> {
  if (!image.data) throw new Error('图片内容为空,无法上传')
  if (!isAvailable()) {
    // 未安装 cos-image-upload skill(分发到他人机器的常态)。给出明确原因,
    // 渲染层据此回退到本地图片,不影响使用。
    throw new Error('COS 上传未配置(未找到 cos_upload.py);已回退本地图片')
  }
  const ext = EXT_BY_TYPE[image.mediaType] ?? 'png'

  const dir = mkdtempSync(join(tmpdir(), 'ba-upload-'))
  const file = join(dir, `${randomBytes(6).toString('hex')}.${ext}`)
  try {
    writeFileSync(file, Buffer.from(image.data, 'base64'))
    const raw = await runUpload(file)
    if (!/^https?:\/\//i.test(raw)) {
      throw new Error(`上传脚本未返回有效 URL:${raw.slice(0, 200)}`)
    }
    // CDN 同时支持 https,统一升到 https:渲染层 CSP 的 img-src 只放行 https,
    // 且避免打包后页面在 https 下加载 http 图片被当成混合内容拦掉。
    const url = raw.replace(/^http:\/\//i, 'https://')
    return { url }
  } finally {
    // 递归删掉临时目录,忽略清理失败
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

function runUpload(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cwd = scriptsDir()
    // 允许用户把 cos_config.json 放到 userData(无需改包内文件);存在就指给脚本。
    // 也可继续用 COS_* 环境变量,脚本两者都认。密钥不打进包。
    const env = { ...process.env }
    if (!env.COS_CONFIG) {
      const userCfg = join(app.getPath('userData'), 'cos_config.json')
      if (existsSync(userCfg)) env.COS_CONFIG = userCfg
    }
    const child = spawn(pythonBin(), [join(cwd, 'cos_upload.py'), file], { cwd, env })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('图片上传超时'))
    }, UPLOAD_TIMEOUT_MS)

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))

    child.on('error', (err) => {
      clearTimeout(timer)
      // 常见:没装 python3 或 skill 路径不对
      reject(new Error(`无法启动上传脚本(${pythonBin()}):${err.message}`))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        // 脚本约定:stdout 仅公网 URL(日志走 stderr)。取末行防止偶发多余输出。
        const url = stdout.trim().split('\n').pop()?.trim() ?? ''
        resolve(url)
      } else {
        // stderr 可能含 [ERROR] 配置缺失等说明;不含密钥(脚本不打印密钥)
        reject(new Error(`上传失败(exit ${code}):${stderr.trim().slice(0, 300) || '无输出'}`))
      }
    })
  })
}
