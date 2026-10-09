import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
// 走内层入口,避开 pdf-parse 顶层 index.js 在无 module.parent 时读测试文件的调试副作用
// @ts-expect-error 内层路径无类型声明
import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import type { FileAttachment } from '../shared/types'

/**
 * 把用户上传的文档解析成纯文本,喂给模型。
 *
 * 模型(OpenAI 兼容)只接受文本与图片,拿不了二进制文件,所以这里统一在主进程
 * 解析:文本类直接解码;xlsx/docx/pdf 用对应库抽取文字。单文件截断到 MAX_CHARS,
 * 避免把上下文撑爆;解析失败只返回一句说明,不中断整个 run。
 */

/** 单个文件解析后保留的最大字符数 */
const MAX_CHARS = 20000

/** 按扩展名识别的文本类文件 */
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs',
  'c', 'cpp', 'h', 'sql', 'sh', 'ini', 'conf', 'properties', 'env'
])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function isTextLike(mediaType: string, ext: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    mediaType.includes('json') ||
    mediaType.includes('xml') ||
    mediaType.includes('yaml') ||
    mediaType.includes('csv') ||
    TEXT_EXT.has(ext)
  )
}

function cap(s: string): string {
  const t = s.trim()
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}\n…(内容过长已截断,原文约 ${t.length} 字符)` : t
}

/** exceljs 单元格值可能是对象(富文本/公式/超链接/日期),统一转成文本 */
function cellText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; hyperlink?: string }
    if (typeof o.text === 'string') return o.text
    if (o.result != null) return String(o.result)
    if (typeof o.hyperlink === 'string') return o.hyperlink
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    return ''
  }
  return String(v)
}

async function parseXlsx(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook()
  // @types/node 新版把 Buffer 变成泛型,与 exceljs 旧类型不符,这里放宽
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  const out: string[] = []
  wb.eachSheet((ws) => {
    out.push(`# 工作表:${ws.name}`)
    ws.eachRow((row) => {
      const vals = (row.values as unknown[]).slice(1).map(cellText)
      out.push(vals.join('\t'))
    })
    out.push('')
  })
  return out.join('\n')
}

async function parseDocx(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf })
  return value
}

async function parsePdf(buf: Buffer): Promise<string> {
  const data = await pdfParse(buf)
  return (data as { text?: string }).text ?? ''
}

/** 解析一个文件,返回可读文本(含失败说明,不抛出) */
export async function parseFile(file: FileAttachment): Promise<string> {
  const ext = extOf(file.name)
  let buf: Buffer
  try {
    buf = Buffer.from(file.data, 'base64')
  } catch {
    return `(读取 ${file.name} 失败)`
  }
  try {
    if (isTextLike(file.mediaType, ext)) return cap(buf.toString('utf-8'))
    if (ext === 'xlsx' || ext === 'xls' || file.mediaType.includes('spreadsheet') || file.mediaType.includes('excel')) {
      return cap(await parseXlsx(buf))
    }
    if (ext === 'docx' || file.mediaType.includes('wordprocessing') || file.mediaType.includes('msword')) {
      return cap(await parseDocx(buf))
    }
    if (ext === 'pdf' || file.mediaType === 'application/pdf') return cap(await parsePdf(buf))
    return `(暂不支持解析的文件类型:${file.name};已跳过)`
  } catch (err) {
    return `(解析 ${file.name} 失败:${err instanceof Error ? err.message : String(err)})`
  }
}

/** 解析多个文件,拼成带标题的「附件」文本块(供并入用户消息) */
export async function parseFiles(files: FileAttachment[]): Promise<string> {
  if (files.length === 0) return ''
  const blocks = await Promise.all(
    files.map(async (f) => `【附件:${f.name}】\n${await parseFile(f)}`)
  )
  return blocks.join('\n\n')
}
