import { z } from 'zod';

// Parameter reference for accessing outputs from previous steps
export const ParamReferenceSchema = z.object({
  type: z.literal('reference'),
  source: z.union([
    z.object({ type: z.literal('param'), path: z.string() }),
    z.object({ type: z.literal('output'), stepName: z.string(), path: z.string() })
  ])
});

export type ParamReference = z.infer<typeof ParamReferenceSchema>;

// Condition for conditional step execution
export const StepConditionSchema = z.object({
  type: z.enum(['success', 'failure', 'expression']),
  stepName: z.string().optional(),
  expression: z.string().optional()
});

export type StepCondition = z.infer<typeof StepConditionSchema>;

// Individual step in a composed tool
export const ToolStepSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  server: z.string(),
  tool: z.string(),
  input: z.record(z.union([z.string(), ParamReferenceSchema])),
  output: z.string().optional(),
  condition: StepConditionSchema.optional(),
  rollback: z.object({
    server: z.string(),
    tool: z.string(),
    input: z.record(z.union([z.string(), ParamReferenceSchema]))
  }).optional()
});

export type ToolStep = z.infer<typeof ToolStepSchema>;

// Complete composed tool definition
export const ComposedToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  steps: z.array(ToolStepSchema),
  inputSchema: z.any(), // Will be a Zod schema
  outputSchema: z.any().optional(), // Will be a Zod schema
  metadata: z.record(z.any()).optional()
});

export type ComposedTool = z.infer<typeof ComposedToolSchema>;

// Step execution state
export interface StepState {
  stepIndex: number;
  stepName: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  outputs: Map<string, any>;
  error?: Error;
  startTime?: number;
  endTime?: number;
}

// Rollback operation for atomic execution
export interface RollbackOperation {
  server: string;
  tool: string;
  params: Record<string, any>;
  originalStep: ToolStep;
}

// Complete execution state
export interface ExecutionState {
  toolName: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  currentStep: number;
  steps: StepState[];
  rollbackStack: RollbackOperation[];
  params: Record<string, any>;
  startTime: number;
  endTime?: number;
  error?: Error;
}

// Result of a composed tool execution
export interface ComposedToolResult {
  success: boolean;
  toolName: string;
  stepResults: {
    name: string;
    status: 'success' | 'failed' | 'skipped';
    result?: any;
    error?: Error;
    duration?: number;
  }[];
  outputs: Record<string, any>;
  duration: number;
  rollbackInfo?: {
    triggered: boolean;
    successful: boolean;
    error?: Error;
  };
}

// Validation error types
export interface ValidationError {
  type: 'validation';
  message: string;
  details: {
    field: string;
    error: string;
  }[];
}

export interface CircularDependencyError {
  type: 'circular_dependency';
  message: string;
  cycle: string[];
}

export interface SchemaCompatibilityError {
  type: 'schema_compatibility';
  message: string;
  details: {
    source: string;
    target: string;
    incompatibility: string;
  };
}

export type CompositionError = 
  | ValidationError 
  | CircularDependencyError 
  | SchemaCompatibilityError;

// Helper type for parameter resolution
export type ResolvedParams = {
  [key: string]: string | number | boolean | object | null;
};

// Helper functions for type checking
export const isParamReference = (value: any): value is ParamReference => {
  return value?.type === 'reference';
};

export const isStepCondition = (value: any): value is StepCondition => {
  return value?.type === 'success' || value?.type === 'failure' || value?.type === 'expression';
};
