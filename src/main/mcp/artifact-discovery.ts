import type { Capabilities } from '../../shared/types.js';

/** Shared live guidance for artifact tools, injected prompts and API inference. */
export const ARTIFACT_IMPORT_INSTRUCTIONS =
  'To show an existing web deliverable as an artifact, call artifact {action:"import",path:"/project/restored.html"} with the actual approved standalone HTML file or a build directory containing index.html. Locate it by name if necessary. Import publishes the file directly, so skip source reads, output chunks and reconstruction. If begin already opened a web presentation, pass its exact presentation_id to import.';

export const ARTIFACT_FLOW_REMINDER = ARTIFACT_IMPORT_INSTRUCTIONS +
  ' For new source authored directly in the tool, begin once with title and kind="web", then create with the exact presentation_id, entrypoint and complete files. After success, retain artifact.id and revision. Read before patching with expected_revision, or use present to show the same artifact. Check isError. For local photos and videos, begin with kind="image" or "video", then use that action with the exact presentation_id and approved local path. MP4/WebM up to 128 MiB play in OneCode and Remote.';

/** Shared by every provider; Core's live registrar remains the schema/permission authority. */
export const ARTIFACT_DISCOVERY_INSTRUCTIONS = 'OneCode has a built-in interactive canvas through Core artifact. ' + ARTIFACT_FLOW_REMINDER +
  ' The result appears inline. Use open for an explicitly requested Workbench view or fail to close an unfinished presentation. Preview has no Node, network or CDN access. If artifact is absent from cached direct schemas, inspect ALL_TOOLS.find(t=>t.name==="artifact").inputSchema in Core exec and call tools.artifact with the live schema. Core plugins list also reports built_in_tools, which can use Core directly, exec, or plugins {action:"call",name:"artifact",arguments:{...}}.';

export function artifactDiscoveryInstructions(caps: Capabilities): string {
  return caps.create ? ARTIFACT_DISCOVERY_INSTRUCTIONS + ' For patch use operations:[{op:"upsert",path:"index.html",text:"complete replacement"}], not files or a patch string. A patch updates inline; present reuses artifact_id at the latest reply; open is only for a requested workbench. Never recreate a successful artifact. Browser storage is optional/document-local: guard it, register controls before optional setup, use responsive CSS and devicePixelRatio for canvas. In exec, emit concise metadata instead of whole file sources or catalogs.' : caps.read || caps.metadata
    ? 'Core artifact can list/open retained interactive canvas artifacts and read them when allowed. Creating a new inline artifact requires Create permission; respect the live tool result.' : '';
}
