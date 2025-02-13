import { z } from 'zod';

// Core MCP Schemas
export type DangerLevel = 'none' | 'low' | 'medium' | 'high';

export interface ToolSafetyMetadata {
  isDangerous?: boolean;
  dangerLevel?: DangerLevel;
  dangerDescription?: string;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  safety?: ToolSafetyMetadata;
  inputSchema: {
    type: 'object';
    properties: Record<string, { 
      type: string; 
      description?: string;
      enum?: any[];
    }>;
    required?: string[];
  };
}

export const McpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  safety: z.object({
    isDangerous: z.boolean().optional(),
    dangerLevel: z.enum(['none', 'low', 'medium', 'high']).optional(),
    dangerDescription: z.string().optional(),
    requiresConfirmation: z.boolean().optional(),
    confirmationMessage: z.string().optional()
  }).optional(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.object({
      type: z.string(),
      description: z.string().optional(),
      enum: z.array(z.any()).optional()
    })).optional().transform(val => val ?? {}),
    required: z.array(z.string()).optional()
  })
}).transform((val): McpTool => ({
  ...val,
  inputSchema: {
    ...val.inputSchema,
    properties: val.inputSchema.properties ?? {}
  }
}));

type InferredMcpTool = z.infer<typeof McpToolSchema>;
type _typeCheck = InferredMcpTool extends McpTool ? true : false;

// Server Context Types
export * from './servers/context.mjs';
export * from './servers/filesystem.mjs';
export * from './servers/github.mjs';

export const McpResourceSchema = z.object({
  uri: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional()
});

export const McpResourceTemplateSchema = z.object({
  uriTemplate: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional()
});

// Server Configuration Schema
export const McpServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional()
});

// Runtime State Types
export const McpServerStatusSchema = z.object({
  name: z.string(),
  status: z.enum(['connected', 'connecting', 'disconnected']),
  config: z.string(), // JSON stringified config
  error: z.string().optional(),
  tools: z.array(McpToolSchema).optional(),
  resources: z.array(McpResourceSchema).optional(),
  resourceTemplates: z.array(McpResourceTemplateSchema).optional()
});

export const McpErrorSchema = z.object({
    code: z.string().or(z.number()).optional(),
    message: z.string(),
    details: z.record(z.any()).optional(),
});

export const CallToolRequestSchema = z.object({
    serverName: z.string(),
    toolName: z.string(),
    params: z.object({
    name: z.string(),
    _meta: z.object({
        progressToken: z.union([z.string(), z.number()]).optional(),
    }).optional(),
    arguments: z.record(z.any()).optional(),
    }),
    method: z.literal('tools/call'),
}); 

export const McpToolCallResponseSchema = z.object({
  _meta: z.record(z.any()).optional(),
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('text'),
        text: z.string()
      }),
      z.object({
        type: z.literal('image'),
        data: z.string(),
        mimeType: z.string()
      }),
      z.object({
        type: z.literal('resource'),
        resource: z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
          blob: z.string().optional()
        })
      })
    ])
  ),
  isError: z.boolean().optional()
});

// Export TypeScript types
export type McpResource = z.infer<typeof McpResourceSchema>;
export type McpResourceTemplate = z.infer<typeof McpResourceTemplateSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;
export type McpError = z.infer<typeof McpErrorSchema>;
export type McpToolCallRequest = z.infer<typeof CallToolRequestSchema>;
export type McpToolCallResponse = z.infer<typeof McpToolCallResponseSchema>;

// WebSocket Event Payloads
export const McpServerConnectionPayloadSchema = z.object({
  name: z.string()
});

export const McpServerStatusUpdatePayloadSchema = McpServerStatusSchema;

export const McpToolResultPayloadSchema = z.object({
  toolId: z.string(),
  result: z.any()
});

export type McpServerConnectionPayload = z.infer<typeof McpServerConnectionPayloadSchema>;
export type McpServerStatusUpdatePayload = z.infer<typeof McpServerStatusUpdatePayloadSchema>;
export type McpToolResultPayload = z.infer<typeof McpToolResultPayloadSchema>;

export interface LLMPromptContext {
  serverName: string;
  toolName: string;
  missingFields: Array<{
    name: string;
    type: string;
    description?: string;
  }>;
  currentArgs: Record<string, any>;
  attemptCount: number;
}

export interface LLMPromptResult {
  providedValues: Record<string, any>;
  shouldPromptUser: boolean;
  userPrompt?: string;
}