import { z } from 'zod';
import { BaseServerContext, BaseServerContextSchema } from './context.mjs';

export interface FileSystemServerContext extends BaseServerContext {
  type: 'filesystem';
  config: {
    allowedPaths: string[];
    currentPath?: string;
    workingDirectory?: string;
  };
}

export const FileSystemServerContextSchema = BaseServerContextSchema.extend({
  type: z.literal('filesystem'),
  config: z.object({
    allowedPaths: z.array(z.string()),
    currentPath: z.string().optional(),
    workingDirectory: z.string().optional()
  })
});