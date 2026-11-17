// Define the methods the terminal UI calls for the manual shadow orchestrator commands.
const modelRef = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    id: { type: "string" },
    variant: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["providerID", "id"],
  additionalProperties: false,
}

const target = {
  sessionID: { type: "string" },
  directory: { type: "string" },
}

const registerInput = {
  type: "object",
  properties: {
    ...target,
    text: { type: "string" },
    model: modelRef,
  },
  required: ["text"],
  additionalProperties: false,
}

const registerOutput = {
  type: "object",
  properties: {
    message: { type: "string" },
    sessionID: { type: "string" },
  },
  required: ["message", "sessionID"],
  additionalProperties: false,
}

const wakeInput = {
  type: "object",
  properties: {
    ...target,
    text: { type: "string" },
  },
  required: ["text"],
  additionalProperties: false,
}

const wakeOutput = {
  type: "object",
  properties: {
    message: { type: "string" },
  },
  required: ["message"],
  additionalProperties: false,
}

export const Shadow = {
  id: "shadow-orchestrator",
  methods: {
    registerManual: { input: registerInput, output: registerOutput },
    wakeManual: { input: wakeInput, output: wakeOutput },
  },
  events: {
    started: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
}
