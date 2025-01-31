import { z } from 'zod';

// Base server context interface
export interface BaseServerContext {
  lastAccessed: Date;
  capabilities?: {
    supportsRollback: boolean;
    maxConcurrentCalls: number;
    supportedOperations: string[];
  };
}

// Base server context schema
export const BaseServerContextSchema = z.object({
  lastAccessed: z.date(),
  capabilities: z.object({
    supportsRollback: z.boolean(),
    maxConcurrentCalls: z.number(),
    supportedOperations: z.array(z.string())
  }).optional()
});

// Enhanced state manager interface
export interface EnhancedServerStateManager {
  getLastAccessed(): Date;
  updateLastAccessed(): void;
  getServerType(): string;
  validateOperation(operation: string): boolean;
}

// Union type for all server contexts (will be extended by other files)
export type ServerContextType = BaseServerContext & {
  type: string;
  config: {
    // Server-wide defaults
    [key: string]: any;
    // Tool-specific defaults
    tools?: {
      [toolName: string]: {
        [field: string]: any;
      };
    };
  };
  capabilities?: {
    supportsRollback: boolean;
    maxConcurrentCalls: number;
    supportedOperations: string[];
  };
  lastOperation?: {
    toolName: string;
    timestamp: number;
    success: boolean;
  };
}