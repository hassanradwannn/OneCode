import { relayDigest, relayPublicOrigin, RELAY_MCP_METADATA, RELAY_MCP_PATH } from '../../shared/relay-protocol.js';
import { createMcpIngressRelay } from './tailscale-relay.js';
import { acquireRelayEnrollment } from './relay-enrollment.js';
import { RelayChannel } from './relay-channel.js';
import { readPublicJson } from './tailscale-public.js';
import type { TunnelHandle, TunnelStartOptions } from './index.js';

export async function startRelayMcp(options: TunnelStartOptions): Promise<TunnelHandle> {
  const local = new URL(options.localUrl);
  if (!RELAY_MCP_PATH.test(local.pathname)) throw new Error('The local MCP connector address is invalid.');
  const enrollment = await acquireRelayEnrollment();
  const { credential } = enrollment;
  const publicOrigin = relayPublicOrigin(credential.origin, relayDigest(credential.key), 'mcp');
  const endpoint = new URL(local.pathname, publicOrigin);
  try {
    const proxy = await createMcpIngressRelay(local.origin, publicOrigin.host, '', 'Relay');
    const channel = new RelayChannel(credential, 'mcp', Number(new URL(proxy.origin).port));
    const controller = new AbortController();
    let previous = '';
    let timer: NodeJS.Timeout | undefined;

    const verify = async () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
      let ready = false;
      if (channel.online) {
        try {
          const metadata = await readPublicJson(new URL(RELAY_MCP_METADATA + endpoint.pathname, publicOrigin), { signal, accept: 'application/json' });
          if (metadata.status === 200 && (metadata.json as { resource?: string } | null)?.resource === endpoint.href) {
            const reply = await readPublicJson(endpoint, {
              signal, accept: 'application/json, text/event-stream', headers: options.discoveryHeaders,
              body: JSON.stringify({ jsonrpc: '2.0', id: 'onecode-ingress', method: 'initialize',
                params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'OneCode relay check', version: '1' } } })
            });
            const rpc = reply.json as { id?: string; result?: { protocolVersion?: string; serverInfo?: { name?: string } } } | null;
            ready = reply.status === 200 && rpc?.id === 'onecode-ingress' &&
              typeof rpc.result?.protocolVersion === 'string' && typeof rpc.result.serverInfo?.name === 'string';
          }
        } catch { /* the next check is read-only */ }
      }
      if (controller.signal.aborted) return;
      const detail = ready ? 'Connected through OneCode Relay.' : channel.online ? 'Checking public HTTPS and MCP on the OneCode relay.' : channel.detail;
      if (detail !== previous) {
        const state = ready ? 'connected' : previous ? 'offline' : 'connecting-tunnel';
        previous = detail;
        options.report({ state, detail, publicUrl: ready ? endpoint.href : null });
      }
      timer = setTimeout(() => { void verify(); }, 5_000);
      timer.unref();
    };
    void verify();
    return {
      async stop() {
        controller.abort(); clearTimeout(timer);
        try { await channel.stop(); await proxy.stop(); } finally { enrollment.release(); }
      }
    };
  } catch (error) {
    enrollment.release();
    throw error;
  }
}
