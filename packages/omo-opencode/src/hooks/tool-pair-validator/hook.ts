import { validateToolPairsForMessages } from "./message-transform"
import { createShouldLogRepair } from "./tool-result-repair"
import type { MessagesTransformHook } from "./types"

export function createToolPairValidatorHook(): MessagesTransformHook {
  const shouldLog = createShouldLogRepair()
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      validateToolPairsForMessages(output.messages, shouldLog)
    },
  }
}
