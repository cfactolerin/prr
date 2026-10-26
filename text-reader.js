import { closeSync, fstatSync, openSync, readSync } from "node:fs"

export const textReadLimit = 64 * 1024

export function readTextFile(path, { offset = 1, limit = 2000, cursor } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid text read range")
  const fd = openSync(path, "r")
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error("PRR text read requires a regular file")
    const buffer = Buffer.alloc(64 * 1024)
    const prefix = readSync(fd, buffer, 0, 8192, 0)
    if (buffer.subarray(0, prefix).includes(0) || buffer.subarray(0, 5).toString() === "%PDF-") {
      throw new Error("Binary/PDF content is not supported by PRR text reads; image/PDF support is separate")
    }
    let position = 0
    let line = 1
    let continued = false
    if (cursor !== undefined) {
      let saved
      try { saved = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) } catch { throw new Error("Invalid text read cursor") }
      if (offset !== 1 || !Number.isSafeInteger(saved?.position) || saved.position < 0 || saved.position > stat.size
        || !Number.isSafeInteger(saved.line) || saved.line < 1 || typeof saved.continued !== "boolean") throw new Error("Invalid text read cursor")
      if (saved.size !== stat.size || saved.mtime !== stat.mtimeMs || saved.ino !== stat.ino || saved.dev !== stat.dev) throw new Error("File changed or cursor belongs to another file; restart the text read")
      position = saved.position
      line = saved.line
      continued = saved.continued
    } else {
      while (line < offset && position < stat.size) {
        const length = readSync(fd, buffer, 0, buffer.length, position)
        if (!length) break
        let consumed = 0
        while (line < offset) {
          const end = buffer.subarray(0, length).indexOf(10, consumed)
          if (end < 0) { consumed = length; break }
          consumed = end + 1
          line++
        }
        position += consumed
      }
    }
    const output = []
    let bytes = 0
    const decoder = new TextDecoder("utf-8", { fatal: true })
    while (position < stat.size && output.length < Math.min(limit, 2000) && bytes < textReadLimit - 1024) {
      const length = readSync(fd, buffer, 0, 8196, position)
      if (!length) break
      const maximum = Math.min(8192, textReadLimit - 1024 - bytes, length)
      const newline = buffer.subarray(0, maximum).indexOf(10)
      let end = newline >= 0 ? newline : maximum
      // Leave a split UTF-8 character for the next segment rather than losing bytes.
      if (newline < 0 && end < length) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
      if (!end && newline < 0) break
      let text
      try { text = decoder.decode(buffer.subarray(0, end)) } catch { throw new Error("PRR text read requires UTF-8 text, not binary content") }
      if (text.includes("\0")) throw new Error("PRR text read refuses binary content")
      const row = `${line}${continued ? " (continued)" : ""}: ${text}`
      output.push(row)
      bytes += Buffer.byteLength(row, "utf8") + 1
      position += end + (newline >= 0 ? 1 : 0)
      continued = newline < 0
      if (!continued) line++
    }
    const after = fstatSync(fd)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("File changed during text read; retry")
    const next = position < stat.size
      ? `[More text; continue with cursor: ${Buffer.from(JSON.stringify({ position, line, continued, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev })).toString("base64url")}]`
      : "[End of file]"
    return [...output, next].join("\n")
  } finally { closeSync(fd) }
}
