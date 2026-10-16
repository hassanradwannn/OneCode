import type { McpServer } from '@modelcontextprotocol/server';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { pluginManager } from '../plugins/manager.js';
import { getConfig } from '../config.js';
import { noteOutcome } from './call-context.js';
import { inboundRequestId } from './inbound.js';
import { dispatch, fail, type ToolResult } from './kernel.js';
import { canAddCodeMode, codeModeDeclaration, codeModeHandler } from './code-mode-tool.js';
import { toolSchemaJson } from './tool-declarations.js';
import { codeModeSchema } from './code-mode-runtime.js';
import { geminiRoutingSchemaJson } from '../gemini/routing-schema.js';
import type { CallContext } from './call-context.js';

/** Shared by direct and nested plugin calls; the manager remains schema/admission authority. */
async function runPluginTool(name: string, args: unknown): Promise<ToolResult> {
  if (getConfig().readOnly) return pluginManager.redactResult(fail('TOOL_DISABLED: external plugins are unavailable while CoS read-only mode is on.')) as ToolResult;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('INVALID_ARGUMENTS: plugin arguments must be an object.');
  return await pluginManager.call(name, args as Record<string, unknown>, noteOutcome) as ToolResult;
}

/** Explicit wrappers and code mode use the same child admission, owner and recording path. */
export function invokePluginTool(name: string, args: unknown, parent: CallContext): Promise<ToolResult> {
  return dispatch(name, args, parent.caller.transportKey, parent.caller.requestId, 'plugins',
    () => runPluginTool(name, args), parent);
}

/** Raw SDK handlers keep external JSON Schema intact (including refs and output schemas).
 * Only the new surface uses them; Core/Desktop retain their existing registrar unchanged.
 * Admission is checked by the manager on every call, including stale cached tool names.
 */
export function registerPluginTools(server: McpServer, setupProfileId: string | null = null): PluginToolSchema[] {
  const tools = pluginManager.tools();
  const codeMode = canAddCodeMode(tools);
  const declaration = codeModeDeclaration();
  const runCode = codeModeHandler(() => tools.map(tool => ({ name: tool.name, description: tool.description ?? '' })),
    invokePluginTool,
    { surface: 'plugins' });
  if (codeMode) tools.push({ name: 'exec', title: declaration.title, description: declaration.description,
    inputSchema: toolSchemaJson(codeModeSchema) as (typeof tools)[number]['inputSchema'], annotations: declaration.annotations });
  const nativeTools = tools.map(tool => ({ ...tool, inputSchema: geminiRoutingSchemaJson(tool.inputSchema) }));
  server.server.setRequestHandler('tools/list', async () => ({ tools: nativeTools }));
  server.server.setRequestHandler('tools/call', async (request, context) => {
    const tool = tools.find(item => item.name === request.params.name);
    const result = await dispatch(request.params.name, request.params.arguments ?? {}, context.sessionId ?? null,
      inboundRequestId(), 'plugins', async () => {
        if (request.params.name === 'exec' && codeMode) {
          const parsed = codeModeSchema.safeParse(request.params.arguments);
          return pluginManager.redactResult(parsed.success ? await runCode(parsed.data) : fail('INVALID_ARGUMENTS: exec requires a code string.')) as ToolResult;
        }
        return runPluginTool(request.params.name, request.params.arguments ?? {});
      }, undefined, setupProfileId);
    return server.server.projectCallToolResult(result, tool?.outputSchema);
  });
  return nativeTools.map(tool => ({ ...tool, description: tool.description ?? '' }));
}
