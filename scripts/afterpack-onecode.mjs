import macSeal from './afterpack-macos-adhoc-seal.mjs';
import hotfixRuntime from './afterpack-hotfix-runtime.mjs';
export default async function afterPack(context) {
  await macSeal(context);
  await hotfixRuntime(context);
}
