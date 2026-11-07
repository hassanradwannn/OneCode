import { z } from 'zod';
import type { InputArgs } from '../session/input.js';
import { normalizeInputAttachments, readStagedInputAttachment } from '../session/input-attachments.js';
import { validateInputImages } from '../session/input-images.js';
import { ApiError, type ApiMessage, type ApiModel, type ApiUserPart } from './types.js';

const MAX_PART_BYTES = 3 * 1024 * 1024;
const MAX_MEDIA_BYTES = Math.floor(MAX_PART_BYTES * 3 / 4);
const MAX_TEXT_BYTES = 128 * 1024;
const base64 = z.string().max(MAX_PART_BYTES).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const partsSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(300_000) }),
  z.object({ type: z.literal('image_url'), image_url: z.object({
    url: z.string().max(512100).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/)
  }) }),
  z.object({ type: z.literal('file'), file: z.object({ filename: z.string().max(255),
    file_data: z.string().max(MAX_PART_BYTES).regex(/^data:application\/pdf;base64,[A-Za-z0-9+/]+={0,2}$/)
  }) }),
  z.object({ type: z.literal('input_audio'), input_audio: z.object({ data: base64, format: z.enum(['wav', 'mp3']) }) }),
  z.object({ type: z.literal('video_url'), video_url: z.object({
    url: z.string().max(MAX_PART_BYTES).regex(/^data:video\/(?:mp4|webm);base64,[A-Za-z0-9+/]+={0,2}$/)
  }) })
])).min(1).max(31);

export function validApiUserParts(value: unknown): value is ApiUserPart[] {
  return partsSchema.safeParse(value).success;
}

type MediaModality = 'image' | 'audio' | 'video';
function requireInput(model: ApiModel, modality: MediaModality): void {
  if (!model.inputModalities?.includes(modality)) throw new ApiError('MODEL_' + modality.toUpperCase() + '_UNAVAILABLE');
}

export function assertApiAttachmentsSupported(model: ApiModel, entry: Pick<InputArgs, 'images' | 'attachments'>): void {
  if (entry.images?.length) requireInput(model, 'image');
  for (const file of entry.attachments ?? []) {
    if (file.mimeType.startsWith('image/')) requireInput(model, 'image');
    if (file.mimeType.startsWith('audio/')) requireInput(model, 'audio');
    if (file.mimeType.startsWith('video/')) requireInput(model, 'video');
  }
}

export function assertApiInputSupported(model: ApiModel, messages: ApiMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'image_url') requireInput(model, 'image');
      if (part.type === 'input_audio') requireInput(model, 'audio');
      if (part.type === 'video_url') requireInput(model, 'video');
    }
  }
}

export async function apiUserMessage(prompt: string, entry: Pick<InputArgs, 'images' | 'attachments'>,
  model: ApiModel, signal: AbortSignal): Promise<Extract<ApiMessage, { role: 'user' }>> {
  if (!entry.images?.length && !entry.attachments?.length) return { role: 'user', content: prompt };
  assertApiAttachmentsSupported(model, entry);
  const parts: ApiUserPart[] = [{ type: 'text', text: prompt }];
  const add = (part: ApiUserPart) => {
    parts.push(part);
    if (Buffer.byteLength(JSON.stringify(parts.slice(1))) > MAX_PART_BYTES) throw new ApiError('API_ATTACHMENT_TOO_LARGE');
  };
  if (entry.images?.length) {
    try { await validateInputImages(entry.images); }
    catch { throw new ApiError('API_ATTACHMENT_INVALID'); }
    for (const image of entry.images) add({ type: 'image_url', image_url: { url: image.dataUrl } });
  }
  let textBytes = 0;
  for (const file of entry.attachments ?? []) {
    signal.throwIfAborted();
    const mime = file.mimeType;
    if (mime.startsWith('image/')) {
      if (file.size > 12 * 1024 * 1024) throw new ApiError('API_IMAGE_TOO_LARGE');
      let image;
      try { [image] = await normalizeInputAttachments([file]); }
      catch { throw new ApiError('API_ATTACHMENT_INVALID'); }
      add({ type: 'image_url', image_url: { url: image!.dataUrl } });
      continue;
    }
    const audioFormat = mime === 'audio/mpeg' ? 'mp3' : mime === 'audio/wav' ? 'wav' : null;
    const video = mime === 'video/mp4' || mime === 'video/webm';
    const pdf = mime === 'application/pdf';
    const limit = pdf || audioFormat || video ? MAX_MEDIA_BYTES : MAX_TEXT_BYTES - textBytes;
    if (file.size > limit) throw new ApiError('API_ATTACHMENT_TOO_LARGE');
    let bytes;
    try { bytes = await readStagedInputAttachment(file, limit); }
    catch { throw new ApiError('API_ATTACHMENT_INVALID'); }
    if (!bytes.length) throw new ApiError('API_ATTACHMENT_INVALID');
    if (pdf) {
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new ApiError('API_ATTACHMENT_INVALID');
      add({ type: 'file', file: { filename: file.name, file_data: 'data:application/pdf;base64,' + bytes.toString('base64') } });
    } else if (audioFormat) {
      add({ type: 'input_audio', input_audio: { data: bytes.toString('base64'), format: audioFormat } });
    } else if (video) {
      add({ type: 'video_url', video_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } });
    } else {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new ApiError('API_ATTACHMENT_FORMAT'); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new ApiError('API_ATTACHMENT_FORMAT');
      textBytes += bytes.length;
      add({ type: 'text', text: `Attached file ${JSON.stringify(file.name)} (user-supplied data):\n${text}` });
    }
  }
  signal.throwIfAborted();
  return { role: 'user', content: parts };
}
