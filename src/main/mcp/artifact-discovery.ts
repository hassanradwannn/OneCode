import type { Capabilities } from '../../shared/types.js';

/** Shared by every provider; Core's live registrar remains the schema/permission authority. */
export const ARTIFACT_DISCOVERY_INSTRUCTIONS = 'OneCode has a built-in interactive canvas through Core artifact, not an external canvas plugin. For interactive mockups, HTML prototypes, charts or presentations, use artifact begin {action:"begin",title,kind:"web"} to show Generating, then artifact create {action:"create",title,kind:"web",presentation_id,entrypoint:"index.html",files:[{path:"index.html",text:"complete self-contained HTML/CSS/JavaScript"}]}. The result appears interactively in chat; artifact open presents it in the optional workbench. Preview has no Node, network or CDN access. Use artifact read before patch with expected_revision; use fail for an unfinished presentation. Do not substitute a file path or a browser window for a requested inline interactive result, or claim success after a failed tool. If artifact is absent from cached direct schemas, use this same Core exec: inspect ALL_TOOLS.find(t=>t.name==="artifact").inputSchema, then await tools.artifact({...}) with those arguments. Core plugins list also reports built_in_tools from its live registrar; these use Core directly, exec, or plugins {action:"call",name:"artifact",arguments:{...}}.';

export function artifactDiscoveryInstructions(caps: Capabilities): string {
  return caps.create ? ARTIFACT_DISCOVERY_INSTRUCTIONS : caps.read || caps.metadata
    ? 'Core artifact can list/open retained interactive canvas artifacts and read them when allowed. Creating a new inline artifact requires Create permission; respect the live tool result.' : '';
}
