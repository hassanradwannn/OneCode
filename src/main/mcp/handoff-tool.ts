import { z } from 'zod';
import { currentCaller } from './call-context.js';
import { fail, guard, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { saveGeminiHandoff } from '../bridge.js';

/** App-owned handoff storage is available even when workspace mutation is read-only. */
export function registerHandoffTool(reg: SurfaceRegistrar): void {
  reg.register('save_handoff', toolDeclaration('save_handoff', () => ({
    title: 'Save handoff',
    description: 'Only for the app’s exact Compact & Resume request. Save the complete Markdown handoff to app-owned storage using its issued token. No filesystem path is accepted. The existing stored receipt is returned on retry; a prose reply alone is not saved. Call directly, outside exec. All other work must stop until the successor opens.',
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
