export type SelectedChatReadiness = {
  phase: 'ready' | 'loading' | 'history-wait' | 'reconnecting' | 'refused';
  retryAt?: number;
  reason?: string;
};
