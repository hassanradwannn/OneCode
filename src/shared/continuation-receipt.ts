/** Provider-authored question receipt. Local document custody is not a provider request id. */
export type ContinuationSourceReceipt = {
  provider: 'gemini';
  transport: 'native-question';
  conversationId: string;
  messageId: string;
  accountPath: string;
  tabId: number;
  documentId: string;
} | {
  provider: 'chatgpt';
  transport: 'fiber-question';
  conversationId: string;
  messageId: string;
  accountPath: '';
  tabId: number;
  documentId: string;
};

export function continuationReceipt(value: unknown): ContinuationSourceReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as ContinuationSourceReceipt;
  if (!Number.isSafeInteger(row.tabId) || row.tabId < 0 || typeof row.documentId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(row.documentId) || typeof row.messageId !== 'string' ||
      typeof row.conversationId !== 'string') return null;
  if (row.provider === 'gemini' && row.transport === 'native-question' &&
      /^[a-f0-9]{16}$/.test(row.conversationId) &&
      new RegExp(`^gemini:${row.conversationId}:user:[a-f0-9]{16}$`).test(row.messageId) &&
      (row.accountPath === '' || /^\/u\/[0-9]+$/.test(row.accountPath))) return {
        provider: 'gemini', transport: 'native-question', conversationId: row.conversationId, messageId: row.messageId,
        accountPath: row.accountPath, tabId: row.tabId, documentId: row.documentId };
  if (row.provider === 'chatgpt' && row.transport === 'fiber-question' && row.accountPath === '' &&
      /^[a-f0-9-]{36}$/i.test(row.conversationId) && /^[A-Za-z0-9_-]{1,200}$/.test(row.messageId)) return {
        provider: 'chatgpt', transport: 'fiber-question', conversationId: row.conversationId, messageId: row.messageId,
        accountPath: '', tabId: row.tabId, documentId: row.documentId };
  return null;
}
