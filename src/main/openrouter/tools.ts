/** In-process tool catalogue and dispatch for app-owned OpenRouter turns. */
import { getConfig } from "../config.js";
import { getSession, readLatestUserMessage } from "../session/store.js";
import { listInputs } from "../session/input.js";
import { withMcpProvider } from "../mcp/provider-context.js";
import { createRegistrar, type ToolContext } from "../mcp/kernel.js";
import { registerCoreTools } from "../mcp/tools-core.js";
import { emptyEvidence, type CallContext } from "../mcp/call-context.js";
import type { OpenRouterTool } from "./client.js";

const apiOwner = "onecode:openrouter-api";
export type OwnedTurn = { sessionId: string; conversationId: string; inputId: string;
  messageId: string; turnId: string; signal: AbortSignal };

/** No model-supplied ID can establish ownership. Only an admitted local input may do so. */
export async function currentOpenRouterTurn(turn: OwnedTurn): Promise<boolean> {
  if (turn.signal.aborted) return false;
  const session = await getSession(turn.sessionId);
  if (!session || session.conversationId !== turn.conversationId ||
      session.activeTurnId !== turn.turnId) return false;
  const input = (await listInputs()).find(row => row.id === turn.inputId);
  if (!input || input.sessionId !== turn.sessionId || input.conversationId !== turn.conversationId ||
      input.messageId !== turn.messageId || input.owner !== apiOwner || input.state !== "sent" ||
      input.deliveredAt === undefined || input.cancelledByUser) return false;
  const latest = await readLatestUserMessage(turn.sessionId);
  return !turn.signal.aborted && latest?.messageId === turn.messageId && latest.inputId === turn.inputId;
}

export function openRouterTools(turn: OwnedTurn) {
  const config = getConfig();
  const ctx: ToolContext = {
    roots: config.roots, caps: config.capabilities, readOnly: config.readOnly,
    sessionTools: config.sessions.record, agentTools: config.multiAgent.enabled,
    privacyScreenshots: config.ui.privacyScreenshots,
  };
  const registry = withMcpProvider("openrouter", () => {
    const local = createRegistrar(null, ctx, "core");
    registerCoreTools(local);
    return local;
  });
  const current = () => currentOpenRouterTurn(turn);
  const declarations: OpenRouterTool[] = registry.descriptions()
    .filter(item => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name))
    .map(item => ({ type: "function", function: { name: item.name,
      description: item.description, parameters: item.inputSchema } }));
  return {
    declarations,
    async invoke(name: string, args: unknown) {
      const context: CallContext = {
        startedAt: Date.now(), transportKey: null, agent: null, allowUnattributed: false,
        caller: { transportKey: null, requestId: null, conversationId: turn.conversationId,
          sessionId: turn.sessionId }, localApiTurnId: turn.turnId,
        outcome: null, evidence: emptyEvidence(),
        publication: { completedAt: null, failed: false }
      };
      return withMcpProvider("openrouter", () => registry.invokeOwned(name, args, context, current));
    }
  };
}
