import { stripVTControlCharacters } from "node:util"

export function parseCliJson(output, { allowEmpty = false } = {}) {
  const text = stripVTControlCharacters(output).trim()
  return allowEmpty && text === "" ? null : JSON.parse(text)
}
