The Gemini adapter preserves the upstream content recorder, durable background outbox,
input claims, browser-document epochs, worker routing, and Goal/Loop owners. It replaces
the provider page boundary rather than inventing Google request headers or using private
Google endpoints.

`gemini-dom.js` reads Gemini's rendered `user-query`, `model-response`, rich-textarea editor,
native conversation-container exchange IDs, mode picker, and `remy-confirmation-card` permission cards. The real
page evidence was captured on October 15, 2026. Assistant transcript publication and final
response detection are explicit Gemini paths in `content.js`; ChatGPT Fiber/usage readers
are neither injected nor treated as evidence.

An app-authored message in an identified chat asks the authenticated extension worker for
that exact chat's binding. The worker verifies the Gemini sender origin and current Chrome
tab URL, then performs a read-only URL query targeted to the authenticated source documentId.
One exact top-frame/document result and the current tab must agree before and after the
paired loopback request. This supports stale MessageSender /app URLs after a same-document
warm-up without admitting a replaced document or another route. The app's pairing
token never leaves the worker. Only a scoped session credential is appended to the outgoing
MCP control frame; the recorder strips that frame from user transcript/receipt comparisons.
Each frame directs Gemini to use only the current schemas of the app selected in that message,
so reconnecting an app does not invite copying an obsolete function namespace from history.

A fresh chat first receives a controlled no-tool warm-up. The task is sent only after an
actual Gemini conversation URL exists and the warm-up settles. Both messages have one
native click; an ambiguous acceptance never causes an automatic resend. The warm-up is
excluded from the authored task transcript. The connector is selected through Gemini's
actual @ menu and must produce a real native mention token before Send.
Before a warm-up click, the real task must leave Gemini's Send model through the observed
settled empty editor/disabled-or-absent Send checkpoint. The adapter then inserts only
WARMUP and waits for native Send readiness. A rendered text replacement alone cannot spend
that click while Gemini still holds the previous real-task model.
The selector clears its owned task and waits for Gemini's rendered empty Quill paragraph and absent/disabled Send control, then establishes and confirms a collapsed P/0 caret before inserting `@`, under an exact app-owned temporary edit snapshot,
then restores the original task while retaining the menu-proven native token. Foreign edits
and route changes revoke that preparation instead of being overwritten. Failed selection
restores only the unchanged app-owned task.

Fresh workers and Resume use the existing redeemed command lease. The worker persists its
client/tab/document custody before answering redeem and forwards that proof with binding.
Warm-up does not dispatch Resume or ACK a worker. Actual task Send performs the final
destination authorization; only its exact native user receipt produces the canonical ACK.

Automatic approval applies only to a native permission card naming the configured connector
and a currently enabled tool returned by the paired app. Each card is clicked once. A changed
card, unrelated connector, disabled tool, disabled policy, or changed chat remains pending.
Parallel cards are each checked independently against their own connector's enabled tools;
the manual card selector remains unique. Historical disabled decisions and Expand text
controls are idle. A click is recorded as `clicked`; tool execution still requires the real
MCP result. The existing desktop approval UI remains available.
Native approval answers are not identified by their text or single-line CSS. A receipt of
our actual scoped decision click links only the next matching native exchange after the
exact rendered card; its disabled decision state confirms the control row. Trusted composer
edits/Send, navigation, a replaced card or a 30-second expiry revoke pending correlation.
Typed and historical unproven Allow/Deny remain authored messages. Proven control rows do
not split the original task turn; assistant continuation/finality still belongs to that turn.
The native Markdown helper preserves code fences and semantic response formatting before
the existing recorder stores text; native controls and card arguments remain omitted.

Planner helpers use ordinary Gemini chats tagged `cos-helper=planner`, with local tools
absent. This is explicitly not native Gemini Temporary Chat. Their native account history
can remain after the app closes their exact owned tab. Native ChatGPT Projects and plugin
refresh controls have no assumed Gemini equivalent; local workspace/project engines remain
in the app. Broader browser tools still require their appropriate browser permissions;
Chrome debugger access is manifest-declared; the companion never offers an unsupported optional debugger grant.
Google account cookies are never extracted or transplanted.

Focused checks: `node node_modules/vitest/vitest.mjs run test/gemini-browser-dom.test.ts
test/gemini-browser-background.test.ts test/gemini-browser-routing.test.ts test/gemini-browser-popup.test.ts test/active-tabs.test.ts`
passed 241 tests. These include production binding
relay races, exact receipt/no-resend behavior, fresh-chat warm-up and binding, enabled-tool
approval boundaries, and the entire existing content recorder with native Gemini messages,
Desktop opening/existing-chat delivery, worker and Resume warm-up/dispatch/receipt behavior.
Observed account-index routes `/u/N/app` and `/u/N/app/<16hex>` use the same home and
conversation checks as `/app`. Only the exact Gemini HTTPS origin qualifies; account indexes
are routing prefixes, while the canonical conversation identity remains the native 16hex ID.
No account prefix, URL or model text substitutes for the current Chrome document/binding proof.
Model discovery uses the shared asynchronous picker-readability contract, including on a
borrowed idle chat. Native settings pages supply selected-account presentation only; they
cannot become model-inspection candidates or strand discovery on a missing composer.
Only an explicitly allowed fresh helper bypasses positively identified busy app pages;
unsent drafts retain their existing ownership and refusal rules.
Native model inspection reads the rendered `gem-menu-item` mode IDs and labels, requiring
the selected class and native Selected icon to agree. Locked upgrades and non-model rows
are excluded. A requested selection is confirmed by reopening that same owned menu and
reading its selected ID; the closed Gemini/Flash caption cannot prove a specific version.
Automatic preserves the current native choice. Unobserved reasoning levels are not offered.
The desktop model chooser retains observed models even when Gemini exposes no separate
thinking-effort catalog. Such a selection sends the exact model with a null effort override;
a previously explicit, now-unverified effort still requires the user's deliberate consent.
Native uploads open Upload and tools and elect the advanced Files owner's hidden input,
never one of the duplicate image/document inputs elsewhere in the menu. Completed previews
belong to the exact input-area-v2 composer. Each filename comes from the preview's referenced
native tooltip, including images whose close control is generic and documents whose visible
caption omits the extension. Exact filename multiplicities, preview count, native progress,
structurally enabled removal controls and Send readiness must all agree. Native removal
controls hidden by hover CSS remain valid; previews and filename evidence must stay visible.
Rejections and lost draft/route
ownership preserve the unsent draft. Fresh-chat files are deferred until the tool-free
warmup has settled, and their exact preview/name lease is rechecked before task authorization.
Native shells with an empty/undefined/index-only exchange ID are unreadable as messages
until the rendered 16hex conversation-container ID hydrates. In particular,
user-query-content-undefined never becomes an ACK or history identity. This keeps a delayed
Desktop ACK and its later hydrated row on one question, without changing native completion
evidence or replaying a Send.
After a Gemini Desktop Send proves its exact current native question, delivery invokes the
normal observation/flush owner before its original ACK. A bounded existing activity read may
release a still-pending identity gate; the receipt never bypasses that gate or reads another
route's history. If identity remains unavailable, the already witnessed Send still receives
its ordinary ACK rather than being replayed. This reduces hidden-observer latency; it does
not claim that Google waits for Desktop ACK, assign earlier calls to a future turn, or lift
the separate worker/Resume command journal gate.
When an existing app opening/command owns a valid length-framed context whose first line
is exactly `@gemini-code`, its existing tool-free warm-up attempts that native Skill option
and newly rendered token before Core is selected for the later real task. Pasted text alone
cannot prove selection. If no unique option is available, only an unchanged restored app
draft with the same route, claim and attachments can fall back to the ordinary tool-free
warm-up. A changed draft or lost ownership refuses Send. Other prompts, malformed frames
and local planners keep their existing bootstrap. This adds no Send or binding authority.
The exact plain/selected-Skill warm-ups, including native paragraph wrapping, are recognized
for acceptance and display suppression. Candidate162d7ecfc311 verified automatic native Skill
selection in account1 by returning its saved GC-SKILL-4fce9b72 marker. Other accounts still
need their own available native Skill; fallback never claims a Skill loaded.
Approval proof diagnostics retain at most20 fixed-schema metadata rows in the current
adapter. Existing page-status and paired companion diagnostics carry only native exchange
IDs, booleans, fixed stage/reason labels and timestamps. The bridge validates these fields
again and logs changed snapshots as `Gemini approval audit:`. They grant no ownership,
rewrite no recorded history, and include no prompt, tool arguments, key or full URL.
An exact scoped approval click may retain its original30s receipt after card removal only
if both original decision buttons were observed ended while mounted in the same native
exchange. Source identity, route, edits, expiry and a new adjacent exact decision row still
fence classification. Removed/unobserved/replaced controls do not acquire that completion.
If Gemini later mounts the final continuation in a new section of that same owned question,
only a native final footer can advance an unknown quiet boundary and restart ordinary
settlement. Existing completion, errors, cancellation and real generation keep their priority.
`gemini-routing.js` preserves the account of an exact observed source chat when creating its
worker/successor. Source-free New chat uses the selected native tab in the owned window, or
the actual last-focused browser window. It never selects an account by arbitrary tab order.
Known-session reopenings use bounded, sanitized Chrome-observed app paths retained across
extension/browser restarts; no query, capability or transcript is stored there. Unknown,
changed or conflicting account context refuses creation instead of silently selecting account0.
A fresh idle-page election resolves that selected account before looking for reusable tabs;
an eligible chat from another account cannot be borrowed first. An already elected recovery
keeps its original document and account custody.
Proven pre-Send preparation refusals fail the existing Desktop claim with a fixed diagnostic
code; they do not disappear into a generic preparation timeout. Once Send authorization
begins, that diagnostic cannot declare the task safely unsent or enable a replay.
The native editor's observed false `execCommand` result uses the same verified text/input-event
fallback for selector insertion as task insertion; a real native menu and token remain required.
If execCommand returns false after producing the exact intended rendered edit, the adapter
preserves that successful native edit and popup instead of replacing it. Session frame
appending uses the same observation to avoid duplicate control frames.
Its temporary empty/@/token stages tolerate observed asynchronous Quill paragraph normalization
with unchanged text. Trusted human input outside the synchronous app edit revokes preparation;
the restored task retains its original draft and route checks.
Paired native sequence probes establish that both nonempty replacement and immediate insertion
after clearing fail to open the menu. Only the observed settled empty document permits the
native selector; the adapter waits on that state instead of using a fixed delay.
When Quill briefly expands the same bold token through a restored task, its verified text
edit remains provisional inside that exact owned transition. Preparation cannot finish
until the original strong node again contains only the exact connector name and the full
authored task matches. A different token or unconfirmed normalization never authorizes Send.
Native user text excludes only Gemini's h5.screen-reader-user-query-label accessibility
duplicate, which may be truncated and otherwise breaks the complete visible-task receipt.
The native user node remains unchanged; ordinary authored headings remain in the transcript.
Permission cards use the captured connector-only header and body permission paragraph;
those connector names must agree before the scoped enabled-tool policy can approve them.
Fresh Desktop acceptance includes a delayed native Send-model fixture, not just DOM readback:
only WARMUP is sent before task authorization. A missing empty-model checkpoint or foreign
draft edit cannot click warm-up or actual Send, ACK, or overwrite that foreign draft.
Final task delivery tolerates native Send disappearing/remounting while Core finishes
loading, but only under the same exact task, editor, route and caller lifetime. It obtains
one actual-task grant, then may wait under that same grant before its single click; it
does not reauthorize or replay. Foreign draft changes abort the wait immediately.
An owned native response with its completed footer settles after the existing quiet window,
even when Gemini returns no visible answer. Its recorder detail states that the answer was
empty; this is generation completion, not evidence that a tool or the requested task succeeded.
Current errors and explicit Stop retain priority. A pending approval, busy response, missing
completed footer, or historical answer above the current question cannot establish completion.
Native work never takes OS focus. Helpers reuse one normal expanded owned window, created
with focused:false. Exact task presentation may select its own tab once; personal windows
and tab groups are not selected or raised. Explicit user actions such as Open in Gemini still
reveal the requested chat. Ordinary Desktop inputs, commands, catalog inspection and revival
have no optional-permission setup button or forced minimized state. The rendering controller checks actual manifest-granted access before attaching.
The exact document/election or deferred command and unchanged route remain required before
preparation and dispatch. Custody loss refuses the existing operation without authorizing a replay.
The lightweight rendering controller remains dormant without actual debugger access. It uses only Emulation.setFocusEmulationEnabled and never
grants MCP access or Send authority. It may project an existing redeemed command's original
document through tool-free warm-up until expiry, with canonical active policy taking over at ACK;
unavailable debugging never blocks the ordinary normal-window path.
Blank pages retaining a worker/continuation `clf` query or hash marker are ineligible for
ordinary Desktop input reuse, even after that command expires. Background candidate selection
and the content readiness proof both preserve that separate lifecycle; they do not rewrite or
replay it to host a new input.
An existing `cos-input` query or hash marker likewise cannot be borrowed for a different input.
The currently elected matching marker still receives its own ordinary document-scoped offer.
A native bootstrap editor remount during initial readiness can rebind its existing command
draft lease once, before any warm-up or task click. The exact route, command lifetime, complete
authored task and attachment nodes must remain unchanged, with no trusted composer edit.
Foreign text, navigation, expired ownership or changed attachments refuse the send. This
continues the same operation and never replays an authorized task.
TypeScript and syntax checks passed. These checks do not substitute for the
real signed-in page acceptance run performed by the parent task.

Gemini CSV uploads use a text view: `table.csv` is sent natively as
`table.csv.txt` with `text/plain`, because the account's native CSV document
loader rejected even a normal file-picker upload. The File wrapper preserves
the exact original bytes, size and last-modified time; desktop attachments and
history retain their original metadata. Same-batch name collisions get a
numbered suffix before `.txt`. Upload confirmation still requires each exact
transported filename and completed native preview. This does not parse or
rewrite CSV, change other file types, or affect another provider's uploads.
