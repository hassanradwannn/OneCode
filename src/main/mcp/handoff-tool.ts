import { z } from 'zod';
import { currentCaller } from './call-context.js';
import { fail, guard, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { saveGeminiHandoff } from '../bridge.js';

/** App-owned handoff storage is available even when workspace mutation is read-only. */
export function registerHandoffTool(reg: SurfaceRegistrar): void {
  reg.register('save_handoff', toolDeclaration('save_handoff', () => ({
    title: 'Save handoff',
    description: 'Compatibility save for an older app-issued Compact & Resume request that explicitly asks for this tool. Current compaction requests require a complete Markdown reply with no tool calls; OneCode captures and saves that completed reply automatically. For an older tool-based request only, save the complete Markdown using its issued token. No filesystem path is accepted. Retries return the existing receipt. Call directly, outside exec.',
    inputSchema: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), markdown: z.string().min(1).max(512 * 1024) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), input => guard('save_handoff', async () => {
    if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');
    const evidence = currentCaller().geminiBinding;
    if (!evidence?.handoff) return fail('HANDOFF_NOT_OWNED: no app-owned handoff was changed.');
    try {
      const result = await saveGeminiHandoff(input.token, input.markdown, evidence);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'HANDOFF_NOT_STORED');
    }
  }));
}
