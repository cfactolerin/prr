import assert from "node:assert/strict"
import { test } from "node:test"
import { diffFiles, displayText, findingRows, referencePatch, safeRepoPath, splitRows } from "../review-diff.js"

const patch = `diff --git a/a.rb b/a.rb
index abc..def 100644
--- a/a.rb
+++ b/a.rb
@@ -10,4 +10,5 @@
 context
-old
+new
+extra
 last
 end
@@ -40 +41 @@
-before
+after
`

test("split positions follow replacement alignment and original line numbers across hunks", () => {
  assert.deepEqual(splitRows(patch), [
    { before: 10, after: 10 }, { before: 11, after: 11 }, { before: undefined, after: 12 },
    { before: 12, after: 13 }, { before: 13, after: 14 }, { before: 40, after: 41 },
  ])
  assert.deepEqual(findingRows(patch, { anchor: "diff", line: 41 }), [5])
  assert.deepEqual(findingRows(patch, { anchor: "diff", start_line: 11, line: 13 }), [1, 2, 3])
  assert.deepEqual(findingRows(patch, { anchor: "none", line: 11 }), [])
})

test("file index handles added, deleted, renamed, binary, quoted Unicode and metadata-only patches", () => {
  const files = diffFiles(patch + `diff --git a/new b/new
new file mode 100644
--- /dev/null
+++ b/new
@@ -0,0 +1 @@
+hello
diff --git a/deleted b/deleted
deleted file mode 100644
--- a/deleted
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name b/new name
similarity index 100%
rename from old name
rename to new name
diff --git "a/caf\\303\\251.png" "b/caf\\303\\251.png"
Binary files "a/caf\\303\\251.png" and "b/caf\\303\\251.png" differ
diff --git a/script b/script
old mode 100644
new mode 100755
`)
  assert.deepEqual(files.map((file) => [file.id, file.path, file.status, file.binary]), [
    ["0", "a.rb", "modified", false], ["1", "new", "added", false], ["2", "deleted", "deleted", false],
    ["3", "new name", "renamed", false], ["4", "café.png", "modified", true], ["5", "script", "modified", false],
  ])
  assert.equal(files[3].oldPath, "old name")
  assert.equal(files[0].patch, patch)
})

test("unchanged reference context retains snapshot line numbers and rejects invalid ranges", () => {
  const reference = referencePatch("a.rb", Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"), 30)
  assert.deepEqual(findingRows(reference, { anchor: "reference", line: 30 }), [5])
  assert.ok(reference.includes("@@ -25,11 +25,11 @@"))
  assert.equal(referencePatch("a.rb", "a\n", 2), null)
  assert.equal(referencePatch("a.rb", "a\n", 1, 2), null)
})

test("reference paths cannot escape the repository and terminal controls are displayed literally", () => {
  for (const path of ["../secret", "a/../../secret", "/etc/passwd", "a\0b", "a//b", "./a", ""]) assert.equal(safeRepoPath(path), false)
  assert.equal(safeRepoPath("lib/a b.rb"), true)
  assert.equal(displayText("hello\x1b]8;;bad\x07\nworld"), "hello\\x1b]8;;bad\\x07\nworld")
})
