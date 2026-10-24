function gitPath(value) {
  if (!value.startsWith('"')) return value
  const bytes = []
  const escapes = { t: 9, n: 10, r: 13, b: 8, f: 12, v: 11, a: 7, '\\': 92, '"': 34 }
  for (let index = 1; index < value.length - 1; index++) {
    if (value[index] !== "\\") {
      bytes.push(...new TextEncoder().encode(value[index]))
      continue
    }
    const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0]
    if (octal) {
      bytes.push(parseInt(octal, 8))
      index += octal.length
    } else {
      bytes.push(escapes[value[++index]] ?? 63)
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function safeRepoPath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/")
    && !path.includes("\0") && !path.split("/").some((part) => part === ".." || part === "." || part === "")
}

export function diffFiles(diff) {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index)
  return starts.map((start, index) => {
    const patch = diff.slice(start, starts[index + 1] ?? diff.length)
    const header = patch.split("\n", 1)[0].slice(11)
    const quoted = header.match(/^("(?:[^"\\]|\\.)*") (.+)$/)
    const split = header.indexOf(" b/")
    const paths = quoted ? [quoted[1], quoted[2]] : [header.slice(0, split), header.slice(split + 1)]
    let oldPath = gitPath(paths[0]).replace(/^a\//, "")
    let path = gitPath(paths[1]).replace(/^b\//, "")
    const metadata = patch.split(/^@@ /m, 1)[0]
    const oldHeader = metadata.match(/^--- (.+)$/m)?.[1]
    const newHeader = metadata.match(/^\+\+\+ (.+)$/m)?.[1]
    if (oldHeader && oldHeader !== "/dev/null") oldPath = gitPath(oldHeader).replace(/^a\//, "")
    if (newHeader && newHeader !== "/dev/null") path = gitPath(newHeader).replace(/^b\//, "")
    const renameFrom = metadata.match(/^rename from (.+)$/m)?.[1]
    const renameTo = metadata.match(/^rename to (.+)$/m)?.[1]
    if (renameFrom) oldPath = gitPath(renameFrom)
    if (renameTo) path = gitPath(renameTo)
    const status = /^new file mode /m.test(metadata) ? "added"
      : /^deleted file mode /m.test(metadata) ? "deleted" : renameTo ? "renamed" : "modified"
    if (status === "deleted") path = oldPath
    return { id: String(index), path, oldPath, status, binary: /^(Binary files |GIT binary patch)/m.test(metadata), patch }
  })
}

// Match OpenTUI's split alignment: each contiguous remove/add block shares rows.
export function splitRows(patch) {
  const rows = []
  let before = 0
  let after = 0
  let inHunk = false
  let removed = []
  let added = []
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.push({ before: removed[index], after: added[index] })
    }
    removed = []
    added = []
  }
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      flush()
      before = Number(hunk[1])
      after = Number(hunk[2])
      inHunk = true
    } else if (inHunk && line.startsWith("-")) removed.push(before++)
    else if (inHunk && line.startsWith("+")) added.push(after++)
    else if (inHunk && line.startsWith(" ")) {
      flush()
      rows.push({ before: before++, after: after++ })
    } else if (inHunk && line.startsWith("\\")) flush()
  }
  flush()
  return rows
}

export function findingRows(patch, finding) {
  if (!finding?.line || finding.anchor === "none") return []
  const start = finding.start_line ?? finding.line
  return splitRows(patch).flatMap((row, index) => row.after >= start && row.after <= finding.line ? [index] : [])
}

export function referencePatch(path, content, line, startLine = line) {
  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (line < 1 || line > lines.length || startLine < 1 || startLine > line) return null
  const start = Math.max(1, startLine - 5)
  const end = Math.min(lines.length, line + 5)
  const quote = (prefix) => JSON.stringify(`${prefix}/${path}`)
  return `diff --git ${quote("a")} ${quote("b")}\n--- ${quote("a")}\n+++ ${quote("b")}\n@@ -${start},${end - start + 1} +${start},${end - start + 1} @@\n${lines.slice(start - 1, end).map((text) => ` ${text}`).join("\n")}\n`
}

export function displayText(text) {
  return String(text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
}
