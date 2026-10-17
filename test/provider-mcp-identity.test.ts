import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConfig, initConfigPath } from '../src/main/config.js';
import { startMcpServer } from '../src/main/mcp/server.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';

describe('provider MCP presentation identity', () => {
  it.each(['gemini', 'chatgpt'] as const)('publishes the configured device name exactly for %s', async provider => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'onecode-identity-'));
    initConfigPath(directory);
    const previous = getConfig().connectorSuffix;
    getConfig().connectorSuffix = 'legion-laptop';
    const endpoint = await startMcpServer(() => ({ roots: [], caps: { ...DEFAULT_CAPABILITIES },
      readOnly: true, sessionTools: false, agentTools: false }), {}, provider);
    try {
      const url = new URL(endpoint.urls.core);
      const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'identity-test', version: '1.0.0'}
      }});
      const reply: any = await new Promise((resolve, reject) => {
        const request = http.request(url, {method: 'POST', headers: {'content-type': 'application/json',
          accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body)}}, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            const json = raw.startsWith('{') ? raw : [...raw.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? '{}';
            try { resolve({status: response.statusCode, ...JSON.parse(json)}); } catch (error) { reject(error); }
          });
        });
        request.on('error', reject); request.end(body);
      });
      expect(reply.status).toBe(200);
      expect(reply.result.serverInfo).toMatchObject({name: 'OneCode Core legion-laptop', title: 'OneCode Core legion-laptop'});
    } finally {
      getConfig().connectorSuffix = previous;
      await endpoint.stop(); await rm(directory, {recursive: true, force: true});
    }
  });
});
