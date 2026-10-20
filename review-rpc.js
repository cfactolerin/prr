import { Rpc } from "@opencode/plugin/rpc"

const session = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
}

export const reviewRpc = Rpc.define({
  id: "prr.review",
  methods: {
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
