import { useCallback, useState } from 'react'
import type { FileAttachment } from '@shared/types'

/**
 * 待发送的文档附件(非图片)。图片走 useAttachments(有缩略图/读图),
 * 这里只管文件名/大小/base64,主进程负责解析成文本喂给模型。
 */

/** 单文件上限;再大 base64 过 IPC + 解析都吃不消 */
const MAX_BYTES = 10 * 1024 * 1024
const MAX_COUNT = 5

export interface PendingFile extends FileAttachment {
  id: string
}

let seq = 0

/** FileReader 读出来的是 data:<type>;base64,<payload>,只要后半段 */
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

export function useFiles() {
  const [files, setFiles] = useState<PendingFile[]>([])
  const [rejected, setRejected] = useState<string | null>(null)

  const add = useCallback(async (list: File[]): Promise<void> => {
    const problems: string[] = []
    const ok: File[] = []
    for (const f of list) {
      if (f.size > MAX_BYTES) problems.push(`${f.name || '未命名'}:超过 10 MB`)
      else ok.push(f)
    }

    const loaded = await Promise.all(
      ok.map(async (file) => {
        try {
          return {
            id: `file-${Date.now()}-${seq++}`,
            name: file.name || '未命名文件',
            mediaType: file.type,
            data: await toBase64(file),
            size: file.size
          } satisfies PendingFile
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err))
          return null
        }
      })
    )

    setFiles((prev) => {
      const merged = [...prev, ...loaded.filter((x): x is PendingFile => x !== null)]
      if (merged.length > MAX_COUNT) problems.push(`最多 ${MAX_COUNT} 个文件,多余的已丢弃`)
      return merged.slice(0, MAX_COUNT)
    })
    setRejected(problems.length ? problems.join(';') : null)
  }, [])

  const remove = useCallback((id: string): void => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const clear = useCallback((): void => {
    setFiles([])
    setRejected(null)
  }, [])

  const payload = useCallback(
    (): FileAttachment[] =>
      files.map(({ name, mediaType, data, size }) => ({ name, mediaType, data, size })),
    [files]
  )

  return { files, rejected, add, remove, clear, payload, full: files.length >= MAX_COUNT }
}
