import type { z } from 'zod';
import { geminiBindingsEnabled } from './bindings.js';
import { toolSchema, toolSchemaJson } from '../mcp/tool-declarations.js';

const routingProperties = {
  conversation_id: { type: 'string', pattern: '^[a-f0-9]{16}$', description: 'Gemini conversation id supplied by this app in the current user turn.' },
  session_key: { type: 'string', pattern: '^sk-gemini-session-[A-Za-z0-9_-]{43}$', description: 'Local session capability supplied with that conversation id. Never invent, print or reuse another chat\'s key.' }
};

/** The wire adds routing fields. HTTP ingress consumes them before tool schema validation. */
export function geminiRoutingSchemaJson<T extends object>(schema: T): T {
  if (!geminiBindingsEnabled()) return schema;
  const input = schema as Record<string, unknown>;
  return { ...schema, type: 'object', properties: { ...(input.properties as object ?? {}), ...routingProperties },
    required: [...new Set([...(Array.isArray(input.required) ? input.required : []), 'conversation_id', 'session_key'])] };
}

/** Standard Schema retains the original validator, including strict objects/refinements. */
export function geminiToolSchema(schema: z.ZodType): ReturnType<typeof toolSchema> {
  const adapter = toolSchema(schema);
  if (!geminiBindingsEnabled()) return adapter;
  return { '~standard': { ...adapter['~standard'], jsonSchema: { ...adapter['~standard'].jsonSchema,
    input: () => geminiRoutingSchemaJson(toolSchemaJson(schema, 'input')) } } };
}
