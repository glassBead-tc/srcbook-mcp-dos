import z from 'zod';

export const McpActionSchema = z.object({
  type: z.literal('mcp'),
  description: z.string(),
  server_name: z.string(),
  tool_name: z.string(),
  arguments: z.record(z.string(), z.any())
});

export type McpActionType = z.infer<typeof McpActionSchema>;

export const McpActionChunkSchema = z.object({
  type: z.literal('action'),
  planId: z.string(),
  data: McpActionSchema
});

export type McpActionChunkType = z.infer<typeof McpActionChunkSchema>;
