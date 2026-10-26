import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { readTextFile, textReadLimit } from "../text-reader.js"

function fixture(t, content) {
  const root = mkdtempSync(join(tmpdir(), "prr-text-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "text")
  writeFileSync(path, content)
  return path
}
const nextCursor = (text) => text.match(/continue with cursor: ([\w-]+)\]/)?.[1]

test("large text files have bounded reads and real line offsets", (t) => {
  const path = fixture(t, "a source line with some text\n".repeat(100_000) + "last line")
  const page = readTextFile(path)
  assert.ok(Buffer.byteLength(page) <= textReadLimit)
  assert.ok(nextCursor(page))
  assert.equal(readTextFile(path, { offset: 100_001 }), "100001: last line\n[End of file]")
  assert.equal(readTextFile(path, { offset: 100_002 }), "[End of file]")
})

test("continuations preserve every UTF-8 byte across long lines and page boundaries", (t) => {
  const long = "a🙂漢".repeat(350_000)
  const path = fixture(t, `${long}\nTAIL`)
  let cursor
  let combined = ""
  let pages = 0
  do {
    const page = readTextFile(path, { cursor })
    assert.ok(Buffer.byteLength(page) <= textReadLimit)
    assert.ok(!page.includes("�"))
    for (const row of page.split("\n").filter((row) => /^\d/.test(row))) {
      if (row.startsWith("2:")) combined += "\n"
      combined += row.replace(/^\d+(?: \(continued\))?: /, "")
    }
    cursor = nextCursor(page)
    pages++
    assert.ok(pages < 200)
  } while (cursor)
  assert.ok(pages > 1)
  assert.equal(combined, `${long}\nTAIL`)
})

test("line limits, empty lines and EOF have explicit continuation", (t) => {
  const path = fixture(t, "one\n\nthree\n")
  const first = readTextFile(path, { limit: 1 })
  assert.match(first, /^1: one\n\[More text/)
  const second = readTextFile(path, { cursor: nextCursor(first), limit: 1 })
  assert.match(second, /^2: \n\[More text/)
  assert.equal(readTextFile(path, { cursor: nextCursor(second) }), "3: three\n[End of file]")
  assert.equal(readTextFile(fixture(t, "")), "[End of file]")
})

test("invalid, stale and cross-file cursors fail rather than skipping evidence", (t) => {
  const path = fixture(t, "one\ntwo")
  const cursor = nextCursor(readTextFile(path, { limit: 1 }))
  assert.throws(() => readTextFile(path, { cursor: "invalid" }), /Invalid text read cursor/)
  assert.throws(() => readTextFile(path, { cursor, offset: 2 }), /Invalid text read cursor/)
  assert.throws(() => readTextFile(fixture(t, "one\ntwo"), { cursor }), /another file/)
  writeFileSync(path, "changed content")
  assert.throws(() => readTextFile(path, { cursor }), /File changed/)
})

test("binary, PDF and invalid UTF-8 content is not decoded as review text", (t) => {
  for (const content of ["%PDF-1.7 document", Buffer.from([0x89, 0x50, 0, 0x47]), Buffer.from([0xff, 0xd8, 0xff])]) {
    assert.throws(() => readTextFile(fixture(t, content)), /Binary\/PDF|binary content/)
  }
})
