import z from 'zod';
import { McpActionSchema } from '../types/mcp.mjs';

export const ActionTypeSchema = z.enum(['file', 'command', 'mcp']);
export const CommandTypeSchema = z.literal('npm install');

export const FileActionSchemaV1 = z.object({
  type: z.literal('file'),
  description: z.string(),
  path: z.string(),
  dirname: z.string(),
  basename: z.string(),
  modified: z.string(),
  original: z.string().nullable()
});

export const CommandActionSchemaV1 = z.object({
  type: z.literal('command'),
  description: z.string(),
  command: CommandTypeSchema,
  packages: z.array(z.string())
});

export const PlanActionChunkSchemaV1 = z.object({
  type: z.literal('action'),
  planId: z.string(),
  data: z.union([FileActionSchemaV1, CommandActionSchemaV1, McpActionSchema])
});

export type FileActionSchemaType = z.infer<typeof FileActionSchemaV1>;
export type CommandActionSchemaType = z.infer<typeof CommandActionSchemaV1>;
export type PlanActionChunkSchemaType = z.infer<typeof PlanActionChunkSchemaV1>;
