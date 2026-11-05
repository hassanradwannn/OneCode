/** The local Core harness shared by API transports. Remote models never supply caller identity. */
import { effectiveCapabilities, getConfig } from "../config.js";
import { getSession, readLatestUserMessage } from "../session/store.js";
import { listInputs } from "../session/input.js";
import { withMcpProvider } from "../mcp/provider-context.js";
import { createRegistrar, type ToolContext } from "../mcp/kernel.js";
import { registerCoreTools } from "../mcp/tools-core.js";
import { registerDesktopTools } from "../mcp/tools-desktop.js";
import { registerCodeMode } from "../mcp/code-mode-tool.js";
import { emptyEvidence, type CallContext } from "../mcp/call-context.js";
import { withManagedSkills } from "../skill-access.js";
import { apiInputOwner } from "./providers.js";
import type { ChatProvider } from "../../shared/chat-provider.js";
import type { ApiTool } from "./types.js";
import type { OutputPublication } from '../codex/unified-exec.js';

export type OwnedTurn = { provider?: ChatProvider; sessionId: string; conversationId: string; inputId: string;
  messageId: string; turnId: string; signal: AbortSignal };

/** Exact admitted outbox + session + question + turn; no model-supplied identity. */
export async function currentApiTurn(turn: OwnedTurn): Promise<boolean> {
  if (turn.signal.aborted) return false;
  const session = await getSession(turn.sessionId);
  if (!session || session.conversationId !== turn.conversationId || session.activeTurnId !== turn.turnId) return false;
  const input = (await listInputs()).find(row => row.id === turn.inputId);
  if (!input || input.sessionId !== turn.sessionId || input.conversationId !== turn.conversationId ||
      input.messageId !== turn.messageId || input.owner !== apiInputOwner(turn.provider ?? 'openrouter') ||
      input.state !== "sent" || input.deliveredAt === undefined || input.cancelledByUser) return false;
  if (input.apiWorker && !await (await import('./workers.js')).apiWorkerInputCurrent(input)) return false;
  const latest = await readLatestUserMessage(turn.sessionId);
  return !turn.signal.aborted && latest?.messageId === turn.messageId && latest.inputId === turn.inputId;
}

export function apiTools(turn: OwnedTurn) {
  const provider = turn.provider ?? 'openrouter';
  const current = () => currentApiTurn(turn);
  const registry = () => withMcpProvider(provider, () => {
    const config = getConfig();
    const ctx: ToolContext = withManagedSkills({ roots: config.roots, caps: effectiveCapabilities(config),
      readOnly: config.readOnly, sessionTools: config.sessions.record, agentTools: config.multiAgent.enabled,
      privacyScreenshots: config.ui.privacyScreenshots });
    const local = createRegistrar(null, ctx, "core");
    registerCoreTools(local);
    registerDesktopTools(local);
    registerCodeMode(local, (name, args, parent) => registry().invokeNested(name, args, parent),
      { windowsDesktop: process.platform === 'win32', surface: 'core' });
    return local;
  });
  return {
    // Rebuild on every API request and every call: newly approved roots/tools are live immediately.
    get declarations(): ApiTool[] {
      return registry().descriptions().filter(item => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name))
        .map(item => ({ type: "function", function: { name: item.name,
          description: item.description, parameters: item.inputSchema } }));
    },
    async invoke(name: string, args: unknown, publication?: OutputPublication) {
      const receipt = publication ?? { completedAt: null, failed: false };
      const context: CallContext = {
        startedAt: Date.now(), transportKey: null, agent: null, allowUnattributed: false,
        caller: { transportKey: null, requestId: null, conversationId: turn.conversationId,
          sessionId: turn.sessionId }, localApiTurnId: turn.turnId, localApiCurrent: current,
        outcome: null, evidence: emptyEvidence(), publication: receipt
      };
      try {
        const result = await withMcpProvider(provider, () => registry().invokeOwned(name, args, context, current));
        // Direct in-process callers receive the complete result here. The API runner supplies
        // its own receipt and completes it only after the actual model-facing delivery.
        if (!publication) receipt.completedAt = Date.now();
        return result;
      } catch (error) { receipt.failed = true; throw error; }
    }
  };
}
