export { default as compositionExecutor } from './executor.mjs';
export { loadComposedTools } from './config.mjs';
export * from './types.mjs';

// Re-export types for external use
export type {
  ComposedTool,
  ToolStep,
  StepCondition,
  ParamReference,
  ComposedToolResult,
  ValidationError,
  CircularDependencyError,
  SchemaCompatibilityError,
  CompositionError
} from './types.mjs';
