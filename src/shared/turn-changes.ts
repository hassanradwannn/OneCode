export interface RecordedChangeRef { callId: string; changeIndex: number }
export interface TurnFileChange {
  path: string;
  added: number;
  removed: number;
  approximate: boolean;
  edits: Array<RecordedChangeRef & { reviewable: boolean }>;
}
export interface RecordedChangeCall {
  callId: string;
  outcome: string;
  changes?: ReadonlyArray<{ path: string; added: number; removed: number; approximate?: boolean; reviewAssetId?: string; reviewable?: boolean }>;
}

/** Totals describe recorded operations. Repeated edits retain their separate snapshots. */
export function summarizeTurnChanges(calls: Iterable<RecordedChangeCall>): TurnFileChange[] {
  const files = new Map<string, TurnFileChange>();
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.outcome !== 'ok' || seen.has(call.callId)) continue;
    seen.add(call.callId);
    for (const [changeIndex, change] of (call.changes ?? []).entries()) {
      let file = files.get(change.path);
      if (!file) {
        file = { path: change.path, added: 0, removed: 0, approximate: false, edits: [] };
        files.set(change.path, file);
      }
      file.added += change.added;
      file.removed += change.removed;
      file.approximate ||= change.approximate === true;
      file.edits.push({ callId: call.callId, changeIndex, reviewable: Boolean(change.reviewAssetId || change.reviewable) });
    }
  }
  return [...files.values()];
}
