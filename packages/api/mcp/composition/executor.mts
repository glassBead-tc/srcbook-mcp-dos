import { MCPHub } from '../mcphub.mjs';
import {
  ComposedTool,
  ToolStep,
  ExecutionState,
  StepState,
  RollbackOperation,
  ComposedToolResult,
  ResolvedParams,
  isParamReference,
  ValidationError,
  ParamReference,
  CompositionError
} from './types.mjs';

export class CompositionExecutor {
  private static instance: CompositionExecutor;
  private hub: MCPHub;
  private tools: Map<string, ComposedTool>;
  private activeExecutions: Map<string, ExecutionState>;

  private constructor() {
    console.log('Creating new CompositionExecutor instance.');
    this.hub = MCPHub.getInstance();
    this.tools = new Map();
    this.activeExecutions = new Map();
  }

  public static getInstance(): CompositionExecutor {
    if (!CompositionExecutor.instance) {
      CompositionExecutor.instance = new CompositionExecutor();
    } else {
      console.log('Returning existing CompositionExecutor instance.');
    }
    return CompositionExecutor.instance;
  }

  /**
   * Register a composed tool
   */
  registerTool(tool: ComposedTool): void {
    // Validate tool definition
    this.validateTool(tool);
    this.tools.set(tool.name, tool);
  }

  /**
   * Execute a composed tool
   */
  async executeTool(
    toolName: string, 
    params: Record<string, any>
  ): Promise<ComposedToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found`);
    }

    // Validate input parameters
    try {
      tool.inputSchema.parse(params);
    } catch (error) {
      throw {
        type: 'validation',
        message: 'Invalid input parameters',
        details: error
      } as ValidationError;
    }

    // Initialize execution state
    const executionId = `${toolName}-${Date.now()}`;
    const state: ExecutionState = {
      toolName,
      status: 'pending',
      currentStep: 0,
      steps: tool.steps.map((step, index) => ({
        stepIndex: index,
        stepName: step.name,
        status: 'pending',
        outputs: new Map()
      })),
      rollbackStack: [],
      params,
      startTime: Date.now()
    };

    this.activeExecutions.set(executionId, state);

    try {
      // Execute steps
      state.status = 'running';
      for (let i = 0; i < tool.steps.length; i++) {
        state.currentStep = i;
        const step = tool.steps[i]!; // Non-null assertion since we're iterating within bounds
        const stepState = state.steps[i]!; // Non-null assertion since arrays are same length

        // Check step condition
        if (step.condition && !await this.evaluateCondition(step.condition, state)) {
          stepState.status = 'skipped';
          continue;
        }

        stepState.status = 'running';
        stepState.startTime = Date.now();

        try {
          // Resolve parameters
          const resolvedParams = await this.resolveParameters(step.input, state);

          // Execute step
          const result = await this.hub.callTool(
            step.server,
            step.tool,
            resolvedParams
          );

          // Store output if specified
          if (step.output) {
            stepState.outputs.set(step.output, result);
          }

          stepState.status = 'success';
          stepState.endTime = Date.now();

          // Add rollback operation if specified
          if (step.rollback) {
            state.rollbackStack.push({
              server: step.rollback.server,
              tool: step.rollback.tool,
              params: await this.resolveParameters(step.rollback.input, state),
              originalStep: step
            });
          }
        } catch (error) {
          stepState.status = 'failed';
          stepState.error = error as Error;
          stepState.endTime = Date.now();
          throw error;
        }
      }

      state.status = 'success';
      state.endTime = Date.now();

      return this.generateResult(state);
    } catch (error) {
      state.status = 'failed';
      state.error = error as Error;
      state.endTime = Date.now();

      // Attempt rollback
      const rollbackInfo = await this.performRollback(state);

      return {
        ...this.generateResult(state),
        rollbackInfo
      };
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  /**
   * Validate a tool definition
   */
  private validateTool(tool: ComposedTool): void {
    // Validate step names are unique
    const stepNames = new Set<string>();
    for (const step of tool.steps) {
      if (stepNames.has(step.name)) {
        throw {
          type: 'validation' as const,
          message: 'Duplicate step names found',
          details: [{
            field: 'steps',
            error: `Step name '${step.name}' is used multiple times`
          }]
        } as ValidationError;
      }
      stepNames.add(step.name);
    }

    // Check for circular dependencies
    this.checkCircularDependencies(tool);

    // Validate server and tool existence
    for (const step of tool.steps) {
      const serverTools = this.hub.getToolsByServer(step.server);
      const tool = serverTools.find(t => t.name === step.tool);
      if (!tool) {
        throw {
          type: 'validation' as const,
          message: 'Invalid tool reference',
          details: [{
            field: 'steps',
            error: `Tool '${step.tool}' not found on server '${step.server}'`
          }]
        } as ValidationError;
      }
    }
  }

  /**
   * Check for circular dependencies in parameter references
   */
  private checkCircularDependencies(tool: ComposedTool): void {
    const graph = new Map<string, Set<string>>();
    
    // Build dependency graph
    for (const step of tool.steps) {
      const deps = new Set<string>();
      for (const param of Object.values(step.input)) {
        if (isParamReference(param)) {
          if (param.source.type === 'output') {
            deps.add(param.source.stepName);
          }
        }
      }
      graph.set(step.name, deps);
    }

    // Check for cycles
    const visited = new Set<string>();
    const path = new Set<string>();

    function dfs(node: string): void {
      if (path.has(node)) {
        const cycle = Array.from(path).slice(Array.from(path).indexOf(node));
        throw {
          type: 'circular_dependency' as const,
          message: 'Circular dependency detected',
          cycle
        };
      }
      if (visited.has(node)) return;

      visited.add(node);
      path.add(node);

      const deps = graph.get(node) || new Set();
      for (const dep of deps) {
        dfs(dep);
      }

      path.delete(node);
    }

    for (const step of tool.steps) {
      dfs(step.name);
    }
  }

  /**
   * Resolve parameter references to actual values
   */
  private async resolveParameters(
    params: Record<string, string | ParamReference>,
    state: ExecutionState
  ): Promise<ResolvedParams> {
    const resolved: ResolvedParams = {};

    for (const [key, value] of Object.entries(params)) {
      if (isParamReference(value)) {
        if (value.source.type === 'param') {
          resolved[key] = this.getNestedValue(state.params, value.source.path);
        } else {
          const { stepName, path } = value.source;
          const step = state.steps.find(s => s.stepName === stepName);
          if (!step) {
            throw new Error(`Referenced step '${stepName}' not found`);
          }
          if (step.status !== 'success') {
            throw new Error(`Referenced step '${stepName}' has not completed successfully`);
          }
          const output = step.outputs.get(path);
          if (output === undefined) {
            throw new Error(`Output '${path}' not found in step '${stepName}'`);
          }
          resolved[key] = output;
        }
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  /**
   * Evaluate a step condition
   */
  private async evaluateCondition(
    condition: NonNullable<ToolStep['condition']>,
    state: ExecutionState
  ): Promise<boolean> {
    if (!condition.stepName) return true;

    const step = state.steps.find(s => s.stepName === condition.stepName);
    if (!step) {
      throw new Error(`Referenced step '${condition.stepName}' not found`);
    }

    switch (condition.type) {
      case 'success':
        return step.status === 'success';
      case 'failure':
        return step.status === 'failed';
      case 'expression':
        if (!condition.expression) return true;
        // TODO: Implement expression evaluation
        return true;
      default:
        return true;
    }
  }

  /**
   * Perform rollback operations
   */
  private async performRollback(
    state: ExecutionState
  ): Promise<NonNullable<ComposedToolResult['rollbackInfo']>> {
    if (state.rollbackStack.length === 0) {
      return {
        triggered: false,
        successful: true
      };
    }

    try {
      // Execute rollback operations in reverse order
      for (const operation of state.rollbackStack.reverse()) {
        await this.hub.callTool(
          operation.server,
          operation.tool,
          operation.params
        );
      }

      return {
        triggered: true,
        successful: true
      };
    } catch (error) {
      return {
        triggered: true,
        successful: false,
        error: error as Error
      };
    }
  }

  /**
   * Generate final execution result
   */
  private generateResult(state: ExecutionState): ComposedToolResult {
    return {
      success: state.status === 'success',
      toolName: state.toolName,
      stepResults: state.steps.map(step => ({
        name: step.stepName,
        status: step.status === 'pending' || step.status === 'running' ? 
          'skipped' as const : 
          step.status as 'success' | 'failed' | 'skipped',
        result: Array.from(step.outputs.entries()).reduce((acc, [key, value]) => ({
          ...acc,
          [key]: value
        }), {}),
        error: step.error,
        duration: step.endTime && step.startTime ? 
          step.endTime - step.startTime : 
          undefined
      })),
      outputs: state.steps.reduce((acc, step) => ({
        ...acc,
        ...Array.from(step.outputs.entries()).reduce((acc, [key, value]) => ({
          ...acc,
          [key]: value
        }), {})
      }), {}),
      duration: state.endTime ? state.endTime - state.startTime : 0
    };
  }

  /**
   * Get a nested value from an object using a dot-notation path
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => 
      current && typeof current === 'object' ? current[key] : undefined, 
      obj
    );
  }
}

// Export singleton instance
const compositionExecutorInstance = CompositionExecutor.getInstance();
export default compositionExecutorInstance;
