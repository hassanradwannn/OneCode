/** A read projection of existing work owners, never an alternate work scheduler. */
export type UpdateBusyReason = NonNullable<import('../shared/types.js').UpdateStatus['busyReasons']>[number];
export async function updateBusyReasons(): Promise<UpdateBusyReason[]> {
  const [calls, recorder, inputs, agents, goal, continuation, bridge, exec, tasks, terminals] = await Promise.all([
    import('./mcp/call-context.js'), import('./session/recorder.js'), import('./session/input.js'),
    import('./agents.js'), import('./goal.js'), import('./session/continuation.js'), import('./bridge.js'),
    import('./codex/manager.js'), import('./task-request.js'), import('./workspace-terminal-ipc.js')
  ]);
  const outbox = await inputs.listInputs();
  // Read the synchronous owners after the asynchronous outbox read, closest to the decision.
  const live = recorder.liveConversations();
  const conversations = new Set([...live.map(row => row.conversationId),
    ...goal.snapshotGoalSwitches().switches.map(row => row.conversationId)]);
  const reasons: UpdateBusyReason[] = [];
  if (calls.inFlightMcpRequests() || calls.inFlightToolCalls()) reasons.push('tools');
  if (live.some(row => row.generating || row.activeTurnId)) reasons.push('generation');
  if (outbox.some(row => !['sent', 'failed', 'cancelled'].includes(row.state))) reasons.push('messages');
  if (agents.pendingWorkerSpawns().length || agents.swarmState().agents.some(row => row.role === 'worker' &&
      ['invited', 'active', 'detached', 'waking'].includes(row.state))) reasons.push('workers');
  if ([...conversations].some(id => goal.goalArmedFor(id) || goal.goalDraftBusy(id))) reasons.push('automation');
  if (continuation.anyContinuationOpen()) reasons.push('continuation');
  if (exec.unifiedExecManager.listProcesses().length) reasons.push('commands');
  if (bridge.pendingCommands().length) reasons.push('browser');
  if (terminals.activeWorkspaceTerminals()) reasons.push('terminals');
  if (tasks.activeTaskRequests()) reasons.push('preparation');
  return reasons;
}

/** Trusted desktop inspection includes every owner, including quarantined/anonymous commands. */
export async function updateWorkDetails(quarantineOffset = 0): Promise<import('../shared/update-work.js').UpdateWorkSnapshot> {
  const [{ unifiedExecManager }, ownership, sessions, bridge, terminals, { redact }] = await Promise.all([
    import('./codex/manager.js'), import('./codex/ownership.js'), import('./session/store.js'),
    import('./bridge.js'), import('./workspace-terminal-ipc.js'), import('./logger.js')
  ]);
  const running = unifiedExecManager.listProcesses();
  const processes: import('../shared/update-work.js').UpdateWorkProcess[] = [];
  for (const process of running) {
    const principal = ownership.execOwner(process.processId);
    const session = principal && !principal.startsWith('request:') ? await sessions.getSession(principal) : null;
    const owner = session?.title || (principal?.startsWith('request:') ? 'Awaiting exact chat attribution' : 'Unattributed local command');
    const command = redact(process.command.replace(/\s+/g, ' ')).slice(0, 400);
    processes.push({ processId: process.processId, incarnation: process.incarnation, pid: process.pid,
      startedAt: process.startedAt, owner, command });
  }
  const inventory = ownership.terminalExecInventory();
  const quarantined = ownership.listQuarantinedExecResults();
  return { processes, inventory: { reserved: inventory.reserved, running: inventory.running, unreadSpooled: inventory.unreadSpooled,
    completedCache: inventory.completedCache, storageFailures: inventory.storageFailures, spoolError: inventory.spoolError },
    quarantinedTotal: quarantined.length, quarantineOffset,
    quarantined: quarantined.slice(quarantineOffset, quarantineOffset + 50).map(row => ({ processId: row.processId, incarnation: row.incarnation,
      command: redact(row.command.replace(/\s+/g, ' ')).slice(0, 400), completedAt: row.completedAt,
      retainedBytes: row.retainedBytes, exitCode: row.exitCode, outputInterrupted: row.outputInterrupted,
      outputCaptureIncomplete: row.outputCaptureIncomplete })),
    browserActions: bridge.pendingCommands().map(row => ({ id: row.id,
    kind: row.what.split(':')[0] || 'browser', error: row.lastError ? redact(row.lastError).slice(0, 160) : null })),
    terminalTabs: terminals.activeWorkspaceTerminals() };
}
