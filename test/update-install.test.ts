import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  requests: 0, tools: 0, live: [] as Array<{ conversationId: string; generating: boolean; activeTurnId: string | null }>,
  inputs: [] as Array<{ state: string }>, spawns: [] as unknown[], workers: [] as Array<{ role: string; state: string }>,
  switches: [] as Array<{ conversationId: string }>, armed: false, draft: false, continuation: false, commands: [] as unknown[], processes: [] as unknown[], tasks: 0, terminals: 0
}));
vi.mock('../src/main/mcp/call-context.js', () => ({ inFlightMcpRequests: () => state.requests, inFlightToolCalls: () => state.tools }));
vi.mock('../src/main/session/recorder.js', () => ({ liveConversations: () => state.live }));
vi.mock('../src/main/session/input.js', () => ({ listInputs: async () => state.inputs }));
vi.mock('../src/main/agents.js', () => ({ pendingWorkerSpawns: () => state.spawns, swarmState: () => ({ agents: state.workers }) }));
vi.mock('../src/main/goal.js', () => ({ snapshotGoalSwitches: () => ({ switches: state.switches }), goalArmedFor: () => state.armed, goalDraftBusy: () => state.draft }));
vi.mock('../src/main/session/continuation.js', () => ({ anyContinuationOpen: () => state.continuation }));
vi.mock('../src/main/bridge.js', () => ({ pendingCommands: () => state.commands }));
vi.mock('../src/main/codex/manager.js', () => ({ unifiedExecManager: { listProcesses: () => state.processes } }));
vi.mock('../src/main/task-request.js', () => ({ activeTaskRequests: () => state.tasks }));
vi.mock('../src/main/workspace-terminal-ipc.js', () => ({ activeWorkspaceTerminals: () => state.terminals }));
const { updateBusyReasons } = await import('../src/main/update-install.js');
beforeEach(() => {
  state.requests = state.tools = state.tasks = state.terminals = 0; state.armed = state.draft = state.continuation = false;
  state.live = []; state.inputs = []; state.spawns = []; state.workers = []; state.switches = []; state.commands = []; state.processes = [];
});
it('reads every canonical work owner, including attribution settling and pre-outbox preparations', async () => {
  expect(await updateBusyReasons()).toEqual([]);
  state.requests = 1; state.tools = 1; state.live = [{ conversationId: 'owned-chat', generating: false, activeTurnId: 'actual-turn' }];
  state.inputs = [{ state: 'queued' }]; state.spawns = [{}]; state.switches = [{ conversationId: 'owned-chat' }]; state.armed = true;
  state.continuation = true; state.processes = [{}]; state.tasks = 1;
  expect(await updateBusyReasons()).toEqual(['tools', 'generation', 'messages', 'workers', 'automation', 'continuation', 'commands', 'preparation']);
});
it('paused automation, terminal inputs and sleeping/finished worker history do not block', async () => {
  state.inputs = ['sent', 'failed', 'cancelled'].map(state => ({ state }));
  state.workers = ['sleeping', 'finished', 'failed'].map(state => ({ role: 'worker', state }));
  state.workers.push({ role: 'prime', state: 'active' });
  state.switches = [{ conversationId: 'paused-chat' }];
  expect(await updateBusyReasons()).toEqual([]);
  state.workers.push({ role: 'worker', state: 'waking' });
  expect(await updateBusyReasons()).toEqual(['workers']);
});
it.each(['browser', 'tool', 'decision', 'queued'])('undelivered %s input is work even with no native generation yet', async value => {
  state.inputs = [{ state: value }]; expect(await updateBusyReasons()).toEqual(['messages']);
});
it('active helper drafting and durable browser commands block before their native reply exists', async () => {
  state.switches = [{ conversationId: 'source' }]; state.draft = true; state.commands = [{}];
  expect(await updateBusyReasons()).toEqual(['automation', 'commands']);
});
it('an open manual shell is conservatively busy until the human closes it', async () => {
  state.terminals = 1; expect(await updateBusyReasons()).toEqual(['commands']);
  state.terminals = 0; expect(await updateBusyReasons()).toEqual([]);
});
