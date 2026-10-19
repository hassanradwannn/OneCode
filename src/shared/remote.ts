import type { ChatProvider } from './chat-provider.js';
import type { ChatModelCatalog } from './chat-models.js';
import type { Config } from './types.js';
import type { ControlApiSession, ControlApiSessionDetail, ControlApiSessionList } from './control-api.js';

/** An explicit projection, never the host config or an Electron IPC envelope. */
export const REMOTE_UI_KEYS = ['chatProvider', 'defaultChatModel', 'defaultChatReasoning', 'followUp', 'enterSends', 'followOutput', 'theme',
  'turnNotifications', 'backgroundChats', 'backgroundPlacement', 'tabsToKeepOpen', 'autoContinue', 'autoSelectSkills', 'rotateTurnMinutes'] as const;
export type RemotePreferences = Pick<Config['ui'], typeof REMOTE_UI_KEYS[number]>;
export interface RemoteDevice { id: string; name: string; expiresAt: number; lastSeenAt: number }
export interface RemoteStatus { enabled: boolean; ready: boolean; url: string | null; error: string | null; devices: RemoteDevice[]; setup?: import('./tailscale-setup.js').TailscaleSetupAction }
export interface RemoteBootstrap {
  host: string;
  version: string;
  providers: Array<{ id: ChatProvider; label: string; models: ChatModelCatalog }>;
  preferences: RemotePreferences;
  preferencesRevision: string;
}
export type RemoteSession = ControlApiSession & { provider: ChatProvider | null };
export type RemoteSessionDetail = Omit<ControlApiSessionDetail, 'session'> & {
  session: RemoteSession;
  plan?: import('./agent-plan.js').AgentPlan | null;
  selection?: { model: string; reasoningEffort?: import('./session.js').ReasoningEffort } | null;
};
export type RemoteSessionList = Omit<ControlApiSessionList, 'sessions'> & { sessions: RemoteSession[] };
