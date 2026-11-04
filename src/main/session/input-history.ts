import type { InputEntry } from './input.js';
import { estimateTokens } from '../../shared/session.js';
import { browserInputModel } from '../../shared/input.js';
import { getSession, observeSessionModel, readAsset, readEvents, readLatestUserMessage, upsertMessageEvent, writeAsset } from './store.js';
import { validateInputImages } from './input-images.js';
import { loadNativePackage } from '../native-package.js';
const sharp = loadNativePackage('sharp');
import { positionOf } from '../../shared/chronology.js';
import { notifyChanged } from './recorder.js';
import { logInfo } from '../logger.js';

/** Project a tool handout or proven delivery into history, never the enqueue intent. */
export async function recordDeliveredInput(entry: Readonly<InputEntry>, anchorCommitted?: (seq: number) => void): Promise<boolean> {
  const sessionId = entry.sessionId ?? entry.deliveredSessionId;
  const offered = entry.state === 'tool' && !!entry.owner && Number.isFinite(entry.offeredAt);
  const confirmed = ['sent', 'cancelled'].includes(entry.state) && !!entry.messageId && Number.isFinite(entry.deliveredAt);
  if ((!offered && !confirmed) || !sessionId || entry.purpose === 'decision') return false;
  const messageId = offered ? `input:${entry.id}` : entry.messageId!;
  const time = offered || (messageId.startsWith('input:') && Number.isFinite(entry.offeredAt))
    ? entry.offeredAt! : entry.deliveredAt!;
  const session = await getSession(sessionId);
  if (!session) return false;
  // Automatic Continue can create the next native turn before its exact Send ACK
  // reaches the recorder. Only the frozen rotation source, an accepted native
  // question, and one uniquely open successor may repair that late ordering.
  // Never attach ordinary input/Steer, or infer an owner from browser focus/time.
  let rotationTurnId: string | null = null;
  if (confirmed && entry.state === 'sent' && entry.purpose === 'rotation' && entry.queuedTurn &&
      entry.conversationId && session.conversationId === entry.conversationId &&
      entry.queuedTurn.conversationId === entry.conversationId && session.activeTurnId) {
    const turns = session.timelineTurns ?? {};
    const source = turns[entry.queuedTurn.turnId];
    const successor = turns[session.activeTurnId];
    if (source?.questionId && source.endOrigin !== undefined && successor &&
        successor.origin > source.endOrigin && successor.endOrigin === undefined &&
        successor.questionId === source.questionId &&
        Object.entries(turns).filter(([, turn]) => turn.origin > source.endOrigin!).length === 1) {
      const latest = await readLatestUserMessage(sessionId);
      if (latest?.messageId === source.questionId || latest?.messageId === messageId)
        rotationTurnId = session.activeTurnId;
    }
  }
  const images = [...entry.images ?? [], ...entry.toolImages ?? []];
  const text = entry.deliveryText ?? entry.text;
  // Only an explicit native picker request proves model selection. Finish tasks
  // inherit the page model, so their old queued settings cannot become evidence.
  const selection = browserInputModel(entry);
  if (!messageId.startsWith('input:') && selection.model && entry.conversationId) {
    await observeSessionModel(sessionId, entry.conversationId, selection.model, entry.deliveredAt!, selection.reasoningEffort ?? undefined, selection.modelSurface);
  }
  const message = {
    time, source: 'app' as const, kind: 'user_message' as const,
    // Browser delivery uses its exact native key, so a later page echo updates this row.
    // Tool delivery has no native user row and keeps the stable input id as its key.
    messageId, inputId: entry.id, inputDelivery: offered ? 'offered' as const : 'confirmed' as const, authoredText: entry.text,
    wireTokenEstimate: estimateTokens(text),
    ...(messageId.startsWith('input:') && entry.toolTurnId ? { turnId: entry.toolTurnId }
      : rotationTurnId ? { turnId: rotationTurnId } : {}),
    ...(entry.attachments?.length && entry.transportIntent !== 'tool' ? { attachments: entry.attachments } : {}),
    // Injection does not change the running model. Only the native send path verifies
    // picker selection before delivery; a later sparse browser echo keeps this evidence.
    ...(!messageId.startsWith('input:') && selection.model
      ? { model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      : {}),
    message: { text, chars: text.length, truncated: false }
  };
  // Delivery and its chronology do not depend on optional preview storage. This
  // stable row survives a quota failure; retry only enriches the same origin.
  const committed = await upsertMessageEvent(sessionId, message);
  const anchor = positionOf(committed.event);
  anchorCommitted?.(anchor);
  if (confirmed && committed.changed) logInfo(`input ${entry.id}: accepted Send published to canonical history seq=${anchor}`);
  // Offered → confirmed revises this row in place; count and time cannot reveal it.
  notifyChanged(sessionId);
  if (images.length) {
    await validateInputImages(images);
    const assets = [];
    for (const image of images) {
      assets.push(await writeAsset(sessionId, Buffer.from(image.dataUrl.split(',')[1]!, 'base64'), 'image/webp'));
    }
    await upsertMessageEvent(sessionId, { ...message, assets });
    notifyChanged(sessionId);
  }
  return true;
}

/** Recorded membership, not a supplied filename, grants the renderer image access. */
export async function recordedInputImage(sessionId: string, assetId: string): Promise<string | null> {
  const events = await readEvents(sessionId, { kinds: ['user_message', 'native_image', 'native_video', 'tool_call', 'progress'] });
  const referenced = events.flatMap(event => event.kind === 'user_message' ? event.assets ?? [] :
    event.kind === 'native_image' || event.kind === 'native_video' ? event.asset ? [event.asset] : [] :
    event.kind === 'progress' ? event.presentation?.asset ? [event.presentation.asset] : [] :
    event.kind === 'tool_call' ? event.call.assets ?? [] : [])
    .find(asset => asset.id === assetId && ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType));
  if (!referenced) return null;
  const data = await readAsset(sessionId, assetId, 16 * 1024 * 1024);
  if (!data) return null;
  try {
    const image = sharp(data, { limitInputPixels: 36000000 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || `image/${metadata.format}` !== referenced.mimeType) return null;
    // Decode fully before any bytes reach the renderer; metadata alone accepts broken images.
    await image.stats();
    return `data:${referenced.mimeType};base64,${data.toString('base64')}`;
  } catch { return null; }
}
