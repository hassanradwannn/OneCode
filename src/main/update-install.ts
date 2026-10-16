/** A read projection of existing work owners, never an alternate work scheduler. */
export type UpdateBusyReason = 'tools' | 'generation' | 'messages' | 'workers' | 'automation' | 'continuation' | 'commands' | 'preparation' | 'unavailable';
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
  if (bridge.pendingCommands().length || exec.unifiedExecManager.listProcesses().length || terminals.activeWorkspaceTerminals()) reasons.push('commands');
  if (tasks.activeTaskRequests()) reasons.push('preparation');
  return reasons;
}
