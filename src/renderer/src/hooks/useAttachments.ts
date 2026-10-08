import { useCallback, useState } from 'react'
import type { ImageAttachment } from '@shared/types'

/**
 * 待发送的图片附件。
 *
 * 三个入口共用这一套逻辑:点按钮选文件、往输入框里粘贴、拖进面板。
 * 读成 base64 是因为主进程要的是可直接拼进 data: URL 的裸 base64 ——
 * 走 IPC 传 File 对象不可行(结构化克隆不支持),传 ArrayBuffer 还得在
 * 主进程再转一次,不如在这里一次做完。
 */

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 单张图上限。超过这个大小的截图 base64 之后会让请求体大得离谱。 */
const MAX_BYTES = 5 * 1024 * 1024

/** 与主进程的 MAX_USER_IMAGES 保持一致 */
const MAX_COUNT = 4

export interface PendingImage extends ImageAttachment {
  id: string
  /** 本地预览用的 object URL */
  previewUrl: string
  bytes: number
}

let seq = 0

/** FileReader 读出来的是 `data:<type>;base64,<payload>`,只要后半段 */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) reject(new Error(`读取 ${file.name} 失败`))
      else resolve(result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

export function useAttachments() {
  const [images, setImages] = useState<PendingImage[]>([])
  /** 被拒的文件说明,显示一次后由下一次操作覆盖 */
  const [rejected, setRejected] = useState<string | null>(null)

  const add = useCallback(async (files: File[]): Promise<void> => {
    const problems: string[] = []
    const ok: File[] = []

    for (const file of files) {
      if (!ACCEPTED.includes(file.type)) problems.push(`${file.name || '未命名'}:不支持的格式`)
      else if (file.size > MAX_BYTES) problems.push(`${file.name || '未命名'}:超过 5 MB`)
      else ok.push(file)
    }

    const loaded = await Promise.all(
      ok.map(async (file) => {
        try {
          return {
            id: `img-${Date.now()}-${seq++}`,
            // 粘贴来的文件 name 常常是空的,给个占位好在 UI 里认
            name: file.name || `粘贴图片.${file.type.split('/')[1] ?? 'png'}`,
            mediaType: file.type,
            data: await toBase64(file),
            previewUrl: URL.createObjectURL(file),
            bytes: file.size
          } satisfies PendingImage
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err))
          return null
        }
      })
    )

    setImages((prev) => {
      const merged = [...prev, ...loaded.filter((x): x is PendingImage => x !== null)]
      if (merged.length > MAX_COUNT) {
        problems.push(`最多 ${MAX_COUNT} 张,多余的已丢弃`)
        // 丢掉的预览 URL 要主动释放,否则这块内存到页面卸载才回收
        for (const img of merged.slice(MAX_COUNT)) URL.revokeObjectURL(img.previewUrl)
      }
      return merged.slice(0, MAX_COUNT)
    })

    setRejected(problems.length ? problems.join(';') : null)
  }, [])

  const remove = useCallback((id: string): void => {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((img) => img.id !== id)
    })
  }, [])

  /** 丢弃待发图片,同时释放预览 URL。取消附图时用。 */
  const clear = useCallback((): void => {
    setImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.previewUrl)
      return []
    })
    setRejected(null)
  }, [])

  /**
   * 清空待发列表但保留预览 URL。
   *
   * 发送之后用这个:URL 的所有权转给了消息气泡,这里 revoke 会让已发出的
   * 消息里的缩略图变成裂图。代价是这些 URL 到页面卸载才回收,量很小,可接受。
   */
  const detach = useCallback((): void => {
    setImages([])
    setRejected(null)
  }, [])

  /** 剥掉只给 UI 用的字段,得到可以过 IPC 的净荷 */
  const payload = useCallback(
    (): ImageAttachment[] =>
      images.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
    [images]
  )

  return {
    images,
    rejected,
    add,
    remove,
    clear,
    detach,
    payload,
    full: images.length >= MAX_COUNT
  }
}
