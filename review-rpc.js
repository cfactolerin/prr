import { Rpc } from "@opencode/plugin/rpc"

const session = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
}

const finding = {
  type: "object",
  properties: Object.fromEntries([
    ...["id", "title", "trigger", "severity", "anchor", "origin", "location", "path", "fileID", "why_it_matters", "suggested_fix", "suggested_comment"].map((key) => [key, { type: "string" }]),
    ...["line", "start_line"].map((key) => [key, { type: "integer", minimum: 1 }]),
  ]),
  required: ["id", "title", "trigger", "severity", "anchor", "origin", "why_it_matters", "suggested_fix", "suggested_comment"],
  additionalProperties: false,
}

export const reviewRpc = Rpc.define({
  id: "prr.review",
  methods: {
    investigation: {
      input: session,
      output: {
        type: "object",
        properties: {
          snapshot: { type: "string" }, round: { type: "string" }, verdict: { type: "string" }, confidence: { type: "string" }, warnings: { type: "string" },
          findings: { type: "array", items: finding },
          files: { type: "array", items: {
            type: "object",
            properties: {
              id: { type: "string" }, path: { type: "string" }, oldPath: { type: "string" }, status: { type: "string" }, binary: { type: "boolean" },
            },
            required: ["id", "path", "oldPath", "status", "binary"], additionalProperties: false,
          } },
        },
        required: ["snapshot", "round", "verdict", "confidence", "warnings", "findings", "files"], additionalProperties: false,
      },
    },
    diff: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, snapshot: { type: "string" }, fileID: { type: "string" }, findingID: { type: "string" } },
        required: ["sessionID", "snapshot"], additionalProperties: false,
      },
      output: {
        type: "object",
        properties: Object.fromEntries(["patch", "path", "mode", "message"].map((key) => [key, { type: "string" }])),
        required: ["patch", "path", "mode", "message"], additionalProperties: false,
      },
    },
    get: {
      input: session,
      output: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              steps: { type: "array", items: {
                type: "object",
                properties: { label: { type: "string" }, status: { type: "string" } },
                required: ["label", "status"],
                additionalProperties: false,
              } },
              summary: { type: "array", items: {
                type: "object",
                properties: { label: { type: "string" }, text: { type: "string" }, url: { type: "string" } },
                required: ["label", "text"],
                additionalProperties: false,
              } },
            },
            required: ["steps", "summary"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  events: { updated: { schema: session } },
})
