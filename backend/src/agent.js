// FACHADA de compatibilidade: o código do agente foi modularizado em
// backend/src/agent/ (loop, orquestrador, controle, reparos, saídas, visão,
// pesquisa web, prompts, provedor e persistência). Este arquivo apenas
// re-exporta a API pública original com os MESMOS nomes e comportamento, para
// que os importadores existentes (server.js, privacy.js e os testes) não
// precisem mudar.
export {
  withoutSystemNotices,
  shouldRepairOutputDelivery,
  shouldRepairExecution,
  shouldContinueAfterTruncation,
  looksDegenerate,
  textOutputPathFromClaim,
  materializeTextOutput
} from './agent/repair.js';
export { fileSignature } from './agent/outputs.js';
export { clipForBriefing, AGENTS, systemPrompt } from './agent/prompts.js';
export {
  normalizeWebFetchUrl,
  classifyToolOutcome,
  webResearchStopReason,
  planToolCallBatch
} from './agent/webResearch.js';
export { attachImagesToLastUserMessage, stripImagePartsFromMessages } from './agent/vision.js';
export { isRetryableStreamError, friendlyApiError } from './agent/provider.js';
export {
  ConversationBusyError,
  acquireConversationControl,
  releaseConversationControl,
  beginProviderRequest,
  releaseProviderRequest,
  beginToolRequest,
  releaseToolRequest,
  controlInterruptReason,
  setControl,
  isConversationActive
} from './agent/control.js';
export { runAgent } from './agent/loop.js';
export { runOrchestrator } from './agent/orchestrator.js';
export { saveMessage, persistAssistantReply } from './agent/persistence.js';
