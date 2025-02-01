import { z } from 'zod';
import { 
  FileActionSchemaV1, 
  CommandActionSchemaV1,
  ActionTypeSchema,
  CommandTypeSchema
} from '../schemas/actions.mjs';
import { McpActionSchema } from './mcp.mjs';

export type FileActionType = z.infer<typeof FileActionSchemaV1>;
export type CommandActionType = z.infer<typeof CommandActionSchemaV1>;
export type McpActionType = z.infer<typeof McpActionSchema>;

export type ActionType = z.infer<typeof ActionTypeSchema>;
export type CommandType = z.infer<typeof CommandTypeSchema>;

export type FileActionChunkType = z.infer<typeof FileActionSchemaV1>;
export type CommandActionChunkType = z.infer<typeof CommandActionSchemaV1>;

export type McpActionChunkType = z.infer<typeof McpActionSchema>;

export type ActionDataType = FileActionChunkType | CommandActionChunkType | McpActionChunkType;

export type ActionChunkType = {
  type: 'action';
  planId: string;
  data: ActionDataType;
};

export type DescriptionChunkType = {
  type: 'description';
  planId: string;
  data: {
    content: string;
  };
};
