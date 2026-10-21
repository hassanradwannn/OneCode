import { z } from 'zod';
import { currentCaller } from './call-context.js';
import { guard, fail, ok, resolveIn, type SurfaceRegistrar } from './kernel.js';
import { getConfig } from '../config.js';
import { readSkillCatalog } from '../skill-library.js';
import { importSkillFile, importSkillPackage } from '../skills.js';
import { getSessionProject } from '../projects.js';

/** Explicit publication into the same managed library used by the Skills page. */
export function registerSkillsTool(reg: SurfaceRegistrar): void {
  reg.register('skills', {
    title: 'OneCode skills',
    description: 'List OneCode local skills or import a requested skill into the visible Skills library. Create a package with apply_patch at /skills/<id>/SKILL.md (plus references/scripts), or import an approved local file/folder with path and kind. Workspace files alone are not an installed skill. Read the returned catalog to verify publication before claiming installation. onecode-chatgpt is the browser backend skill installed in ChatGPT; it is separate from this local library and need not appear here. Skills add no permissions. Import requires Read files and Create files; read-only mode refuses it.',
    inputSchema: z.object({ action: z.enum(['list', 'import']), path: z.string().min(1).max(4096).optional(),
      kind: z.enum(['file', 'folder']).optional() }).strict().pipe(z.discriminatedUnion('action', [
      z.object({ action: z.literal('list') }).strict(),
      z.object({ action: z.literal('import'), path: z.string().min(1).max(4096), kind: z.enum(['file', 'folder']) }).strict()
    ])),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, input => guard('skills', () => reg.guarded('read', 'skills', async () => {
    const sessionId = currentCaller().sessionId;
    const scope = { projectPath: sessionId ? (await getSessionProject(sessionId))?.real : null };
    if (input.action === 'list') return ok(JSON.stringify(await readSkillCatalog(scope)));
    if (reg.ctx.readOnly || getConfig().readOnly) return fail('TOOL_DISABLED: skill installation is disabled in Read-only mode.');
    return reg.guarded('create', 'skills', async () => {
      const source = await resolveIn(reg.ctx.roots, input.path, { access: 'read' });
      const installed = input.kind === 'folder' ? await importSkillPackage(source.real) : await importSkillFile(source.real);
      return ok(JSON.stringify({ installed, catalog: await readSkillCatalog(scope) }));
    });
  })));
}
