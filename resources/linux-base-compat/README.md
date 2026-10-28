# Frozen Linux base compatibility resource

WINDOWS-SETUP.md is an exact copy of `v0.5.9:docs/WINDOWS-SETUP.md`, SHA-256 `8cee140940998aeca876e800193ded84c39073d650864e64312ad2a36bcd3145`.

The Linux 0.5.9 base accidentally fingerprints this Windows-only document as immutable. Its bytes must stay identical when building a compatible Linux capsule. afterpack-hotfix-runtime.mjs verifies the pin and preserves the base bytes before inventory. Current guidance remains in docs/WINDOWS-SETUP.md, GitHub and the app UI. Windows packaging continues using the current document. No runtime fingerprint or minimum-base check is relaxed.
