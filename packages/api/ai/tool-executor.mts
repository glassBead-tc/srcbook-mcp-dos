import { MCPHub } from '../mcp/mcphub.mjs';
import { 
  DangerLevel, 
  McpTool, 
  McpToolSchema,
  ServerContextType,
  EnhancedServerStateManager,
  GitHubServerContext,
  FileSystemServerContext
} from '../mcp/types/index.mjs';
import { generateText } from 'ai';
import { getModel } from './config.mjs';
import { LLMPromptContext, LLMPromptResult } from '../mcp/types/index.mjs';

type Tool = McpTool;

// Use our new server context type
type ServerContext = ServerContextType;

interface ServerStateManager extends EnhancedServerStateManager {
  getDefaultForTool(toolName: string, field: string): any;
  updateToolDefaults(toolName: string, defaults: Record<string, any>): void;
  recordOperation(toolName: string, success: boolean): void;
  hasCapability(capability: string): boolean;
}

class DefaultServerStateManager implements ServerStateManager {
  private lastAccessedTime: Date;

  constructor(
    private serverName: string,
    private context: ServerContext,
    private executor: ToolExecutor
  ) {
    this.lastAccessedTime = new Date();
  }

  getLastAccessed(): Date {
    return this.lastAccessedTime;
  }

  updateLastAccessed(): void {
    this.lastAccessedTime = new Date();
    this.context.lastAccessed = this.lastAccessedTime;
    this.executor.updateServerContext(this.serverName, this.context);
  }

  getServerType(): string {
    return this.context.type;
  }

  validateOperation(operation: string): boolean {
    // Validate operation based on server type
    switch (this.context.type) {
      case 'github':
        return this.validateGitHubOperation(operation);
      case 'filesystem':
        return this.validateFileSystemOperation(operation);
      default:
        return true; // Allow by default for unknown server types
    }
  }

  private validateGitHubOperation(operation: string): boolean {
    const context = this.context as GitHubServerContext;
    // Add GitHub-specific validation logic
    return true; // Placeholder - implement actual validation
  }

  private validateFileSystemOperation(operation: string): boolean {
    const context = this.context as FileSystemServerContext;
    // Check if operation path is within allowed paths
    if (operation.includes('path')) {
      const path = this.context.config.path;
      return context.config.allowedPaths.some(allowedPath => 
        path?.startsWith(allowedPath)
      );
    }
    return true;
  }

  getDefaultForTool(toolName: string, field: string): any {
    this.updateLastAccessed();
    
    // Check tool-specific defaults first
    const toolDefaults = this.context.config[toolName];
    if (toolDefaults?.[field] !== undefined) {
      return toolDefaults[field];
    }

    // Fall back to server-wide defaults
    return this.context.config[field];
  }

  updateToolDefaults(toolName: string, defaults: Record<string, any>): void {
    this.updateLastAccessed();
    
    this.context.config = {
      ...this.context.config,
      [toolName]: {
        ...(this.context.config[toolName] || {}),
        ...defaults
      }
    };
    
    this.executor.updateServerContext(this.serverName, this.context);
  }

  recordOperation(toolName: string, success: boolean): void {
    this.updateLastAccessed();
    
    const timestamp = Date.now();
    this.executor.updateServerContext(this.serverName, {
      ...this.context,
      lastOperation: { toolName, timestamp, success }
    });
  }

  hasCapability(capability: string): boolean {
    return this.context.capabilities?.supportedOperations?.includes(capability) ?? false;
  }
}

interface ToolExecutionParams {
  serverName: string;
  toolName: string;
  arguments: Record<string, any>;
}

interface ToolExecutionResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  missingFields?: string[];
  rollbackError?: string;
}

interface ToolSafetyConfig {
  dangerousFields: string[];
  sensitiveFields: string[];
  autoFillDefaults?: Record<string, any>;
  dangerousKeywords?: string[];
  confirmationRequired?: {
    dangerLevels?: DangerLevel[];
    tools?: string[];
    patterns?: RegExp[];
  };
}

interface ToolExecutorConfig {
  maxRetries?: number;
  llmEnabled?: boolean;
  safetyConfig?: ToolSafetyConfig;
}

interface OperationState {
  type: keyof typeof OPERATION_TYPES;
  serverName: string;
  toolName: string;
  args: Record<string, any>;
  previousState?: any;
}

interface RollbackResult {
  success: boolean;
  error?: string;
}

// Common dangerous keywords that suggest a tool might need confirmation
const DANGEROUS_KEYWORDS = [
  'delete', 'remove', 'drop', 'truncate', 'push', 'write',
  'modify', 'update', 'alter', 'exec', 'execute', 'format'
];

// Operation types for state management
export const OPERATION_TYPES = {
  DELETE: 'DELETE',
  WRITE: 'WRITE',
  MODIFY: 'MODIFY',
  EXECUTE: 'EXECUTE',
  FORMAT: 'FORMAT'
} as const;

// Dangerous operation patterns that require confirmation
const DANGEROUS_OPERATIONS = {
  [OPERATION_TYPES.DELETE]: /delete|remove|drop/i,
  [OPERATION_TYPES.WRITE]: /write|create|push/i,
  [OPERATION_TYPES.MODIFY]: /modify|update|alter/i,
  [OPERATION_TYPES.EXECUTE]: /exec|execute|run/i,
  [OPERATION_TYPES.FORMAT]: /format|clean|clear/i,
} as const;

// Define dangerous operations by category
const DANGEROUS_CATEGORIES = {
  DATA_REMOVAL: {
    operations: ['delete', 'remove'],
    description: 'Permanently removes data or resources'
  },
  STRUCTURE_CHANGES: {
    operations: ['drop'],
    description: 'Destroys data structures or configurations'
  },
  REMOTE_MODIFICATIONS: {
    operations: ['push'],
    description: 'Modifies remote repositories or resources'
  },
  DATA_MODIFICATIONS: {
    operations: ['write', 'modify'],
    description: 'Changes existing data or configurations'
  }
} as const;

// Helper to get all dangerous operations
const getAllDangerousOperations = () => 
  Object.values(DANGEROUS_CATEGORIES)
    .flatMap(category => category.operations);

export class ToolExecutor {
  private mcpHub: MCPHub;
  private serverContexts: Map<string, ServerContext>;
  private toolSchemas: Map<string, Map<string, Tool>>;
  private config: ToolExecutorConfig;

  constructor(
    mcpHub: MCPHub, 
    defaultConfigs?: Record<string, Record<string, any>>,
    config: ToolExecutorConfig = {}
  ) {
    this.mcpHub = mcpHub;
    this.serverContexts = new Map();
    this.toolSchemas = new Map();
    this.config = {
      maxRetries: 3,
      llmEnabled: true,
      safetyConfig: {
        dangerousFields: getAllDangerousOperations(),
        sensitiveFields: ['owner', 'token', 'apiKey'],
        autoFillDefaults: {}
      },
      ...config
    };

    if (defaultConfigs) {
      Object.entries(defaultConfigs).forEach(([serverName, config]) => {
        this.serverContexts.set(serverName, { 
          type: 'default',  
          config,
          lastAccessed: new Date()
        });
      });
    }
  }

  /**
   * Initialize tool schemas from server
   */
  async initializeServerTools(serverName: string): Promise<void> {
    try {
      const tools = await this.mcpHub.listTools(serverName);
      const toolMap = new Map<string, Tool>();
      
      tools.forEach(rawTool => {
        // Parse the raw tool through our schema to ensure type safety
        const tool = McpToolSchema.parse(rawTool);
        toolMap.set(tool.name, tool);
        
        // Mark potentially dangerous tools
        if (this.isDangerousTool(tool)) {
          const context: ServerContextType = this.serverContexts.get(serverName) || {
            type: 'default',
            config: {},
            capabilities: {
              supportsRollback: false,
              maxConcurrentCalls: 1,
              supportedOperations: []
            },
            lastAccessed: new Date()
          };
          context.capabilities = context.capabilities || {
              supportsRollback: false,
              maxConcurrentCalls: 1,
              supportedOperations: []
            };
          context.capabilities.supportsRollback = false;
          context.capabilities.maxConcurrentCalls = 1;
          context.capabilities.supportedOperations = [];
          context.lastAccessed = new Date();
          this.serverContexts.set(serverName, context);
        }
      });

      this.toolSchemas.set(serverName, toolMap);
    } catch (error) {
      console.error(`Failed to initialize tools for server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Execute a tool with validation, injection, and LLM prompting
   */
  async executeTool<T = any>(params: ToolExecutionParams): Promise<ToolExecutionResult<T>> {
    const { serverName, toolName, arguments: toolArgs } = params;
    let currentArgs = { ...toolArgs };
    let attempts = 0;
    let operationState: OperationState | undefined;

    while (attempts < this.config.maxRetries!) {
      try {
        const tool = this.getToolSchema(serverName, toolName);
        if (!tool) {
          return {
            success: false,
            error: `Tool not found: ${serverName}/${toolName}`
          };
        }

        // For dangerous operations, capture state before execution
        if (this.isDangerousTool(tool)) {
          operationState = await this.captureState(serverName, toolName, currentArgs);
        }

        // Check if this is a dangerous tool requiring confirmation
        if (this.requiresConfirmation(serverName, toolName)) {
          const confirmed = await this.getUserConfirmation(serverName, toolName, currentArgs);
          if (!confirmed) {
            return {
              success: false,
              error: 'User denied dangerous operation'
            };
          }
        }

        // Validate and inject missing fields
        const { valid, enrichedArgs, missingFields, error } = await this.validateAndEnrichArguments(
          serverName,
          tool,
          currentArgs
        );

        if (!valid) {
          if (error) {
            return {
              success: false,
              error
            };
          }

          if (this.config.llmEnabled && missingFields) {
            // Try to get missing fields from LLM
            const promptContext: LLMPromptContext = {
              serverName,
              toolName,
              missingFields: missingFields.map((field: string) => ({
                name: field,
                type: tool.inputSchema.properties[field]?.type || 'unknown',
                description: tool.inputSchema.properties[field]?.description
              })),
              currentArgs,
              attemptCount: attempts
            };

            const llmResult = await this.promptLLM(promptContext);
            
            if (llmResult.shouldPromptUser) {
              return {
                success: false,
                error: llmResult.userPrompt || 'User input required for missing fields',
                missingFields
              };
            }

            // Merge LLM provided values with current args
            currentArgs = {
              ...currentArgs,
              ...llmResult.providedValues
            };
            
            attempts++;
            continue;
          }

          return {
            success: false,
            missingFields,
            error: `Missing required fields: ${missingFields?.join(', ')}`
          };
        }

        // Execute the tool
        const result = await this.mcpHub.callTool(serverName, toolName, enrichedArgs!);

        return {
          success: true,
          data: result as T,
        };

      } catch (error) {
        // If operation failed and we have state, attempt rollback
        if (operationState) {
          const rollbackResult = await this.rollback(operationState);
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            rollbackError: rollbackResult.success ? undefined : rollbackResult.error
          };
        }

        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }

    return {
      success: false,
      error: `Failed after ${attempts} attempts`
    };
  }

  /**
   * Prompt LLM for missing fields
   */
  private async promptLLM(context: LLMPromptContext): Promise<LLMPromptResult> {
    const prompt = this.buildLLMPrompt(context);
    
    try {
      const model = await getModel();
      const response = await generateText({
        model,
        messages: [
          {
            role: 'system',
            content: `You are helping to provide missing arguments for a tool execution.
Your task is to either:
1. Provide the missing values if they can be reasonably inferred from context
2. Or indicate that user input is needed with a clear prompt

For each missing field, you should:
- Consider the field's type and description
- Look at other provided arguments for contextual clues
- If a value cannot be safely inferred, explain why in the userPrompt

Respond in JSON format with:
{
  "providedValues": {}, // Record of field names to values you can determine
  "shouldPromptUser": boolean, // true if user input is needed
  "userPrompt": string, // if shouldPromptUser is true, provide a clear prompt explaining what's needed and why
  "reasoning": string // Optional explanation of how you determined the values or why user input is needed
}`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2 // Lower temperature for more consistent responses
      });

      try {
        const result = JSON.parse(response.text) as LLMPromptResult & { reasoning?: string };
        
        // Log the reasoning for debugging and transparency
        if (result.reasoning) {
          console.debug(`LLM Reasoning for ${context.toolName}:`, result.reasoning);
        }

        // Validate the provided values against the tool schema
        if (Object.keys(result.providedValues).length > 0) {
          const tool = this.getToolSchema(context.serverName, context.toolName);
          if (tool) {
            const validationResult = await this.validateAndEnrichArguments(
              context.serverName,
              tool,
              {
                ...context.currentArgs,
                ...result.providedValues
              }
            );

            // If validation fails, force user prompt
            if (!validationResult.valid) {
              return {
                providedValues: {},
                shouldPromptUser: true,
                userPrompt: `The values I attempted to provide were invalid: ${validationResult.error}\n\nPlease provide valid values for: ${validationResult.missingFields?.join(', ')}`
              };
            }
          }
        }

        return result;
      } catch (e) {
        // Enhanced error handling with specific guidance
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        console.error(`Failed to parse LLM response for ${context.toolName}:`, errorMessage);
        
        return {
          providedValues: {},
          shouldPromptUser: true,
          userPrompt: `I encountered an error while trying to determine the missing values. Please provide the following fields manually:\n\n${
            context.missingFields
              .map(f => `- ${f.name} (${f.type}): ${f.description || 'No description available'}`)
              .join('\n')
          }`
        };
      }
    } catch (e) {
      // Handle LLM API errors gracefully
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      console.error(`LLM API error for ${context.toolName}:`, errorMessage);
      
      return {
        providedValues: {},
        shouldPromptUser: true,
        userPrompt: `I was unable to help determine the missing values due to a technical error. Please provide values for:\n\n${
          context.missingFields
            .map(f => `- ${f.name} (${f.type}): ${f.description || 'No description available'}`)
            .join('\n')
        }`
      };
    }
  }

  /**
   * Build prompt for LLM
   */
  private buildLLMPrompt(context: LLMPromptContext): string {
    const {
      serverName,
      toolName,
      missingFields,
      currentArgs,
      attemptCount
    } = context;

    const tool = this.getToolSchema(serverName, toolName);
    if (!tool) {
      throw new Error(`Tool schema not found: ${serverName}/${toolName}`);
    }

    // Build a detailed context about the tool
    const toolContext = [
      `Tool: ${toolName} on server ${serverName}`,
      `Description: ${tool.description || 'No description available'}`,
      '',
      'Current Arguments:',
      ...Object.entries(currentArgs).map(([key, value]) => 
        `- ${key}: ${JSON.stringify(value)} (${typeof value})`
      ),
      '',
      'Missing Fields:'
    ].join('\n');

    // Build detailed information about each missing field
    const fieldsInfo = missingFields
      .map(field => {
        const schema = tool.inputSchema.properties[field.name];
        const relatedArgs = this.findRelatedArguments(field.name, currentArgs);
        
        return [
          `Field: ${field.name}`,
          `Type: ${field.type}`,
          field.description ? `Description: ${field.description}` : null,
          schema?.enum ? `Allowed Values: ${JSON.stringify(schema.enum)}` : null,
          relatedArgs.length > 0 ? `Related Arguments: ${JSON.stringify(relatedArgs)}` : null,
          ''
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n');

    // Add attempt context for better handling of repeated failures
    const attemptContext = attemptCount > 0 
      ? `\nThis is attempt ${attemptCount + 1}. Previous attempts failed to provide valid values.`
      : '';

    return `${toolContext}\n${fieldsInfo}${attemptContext}

Please analyze the context and either:
1. Provide values for the missing fields if they can be reasonably inferred
2. Indicate that user input is needed with a clear explanation

Remember to consider:
- The relationships between existing and missing arguments
- Any type constraints or allowed values
- The tool's purpose and typical usage patterns
- Whether the values can be safely determined without user input`;
  }

  /**
   * Helper method to find arguments that might be related to a missing field
   * based on name similarity or common patterns
   */
  private findRelatedArguments(fieldName: string, currentArgs: Record<string, any>): Array<{key: string, value: any}> {
    const related: Array<{key: string, value: any}> = [];
    const fieldNameLower = fieldName.toLowerCase();
    
    // Look for arguments with similar names
    for (const [key, value] of Object.entries(currentArgs)) {
      const keyLower = key.toLowerCase();
      
      // Check for common patterns
      if (
        keyLower.includes(fieldNameLower) ||
        fieldNameLower.includes(keyLower) ||
        this.areWordsRelated(keyLower, fieldNameLower)
      ) {
        related.push({ key, value });
      }
    }
    
    return related;
  }

  /**
   * Helper method to check if two words are semantically related
   * This is a simple implementation that could be enhanced with a proper word relationship database
   */
  private areWordsRelated(word1: string, word2: string): boolean {
    // Common related pairs in our domain
    const relatedPairs = new Set([
      ['source', 'destination'],
      ['input', 'output'],
      ['start', 'end'],
      ['from', 'to'],
      ['key', 'value'],
      ['name', 'id'],
      ['path', 'file'],
      ['user', 'owner']
    ]);

    return [...relatedPairs].some(([a, b]) => 
      (word1.includes(a as string) && word2.includes(b as string)) ||
      (word1.includes(b as string) && word2.includes(a as string))
    );
  }

  private async captureState(
    serverName: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<OperationState | undefined> {
    try {
      const state: OperationState = {
        serverName,
        toolName,
        args,
        type: OPERATION_TYPES.MODIFY // Default type
      };

      // Determine operation type from tool name
      if (DANGEROUS_OPERATIONS[OPERATION_TYPES.DELETE].test(toolName)) {
        state.type = OPERATION_TYPES.DELETE;
      } else if (DANGEROUS_OPERATIONS[OPERATION_TYPES.WRITE].test(toolName)) {
        state.type = OPERATION_TYPES.WRITE;
      } else if (DANGEROUS_OPERATIONS[OPERATION_TYPES.MODIFY].test(toolName)) {
        state.type = OPERATION_TYPES.MODIFY;
      } else if (DANGEROUS_OPERATIONS[OPERATION_TYPES.EXECUTE].test(toolName)) {
        state.type = OPERATION_TYPES.EXECUTE;
      } else if (DANGEROUS_OPERATIONS[OPERATION_TYPES.FORMAT].test(toolName)) {
        state.type = OPERATION_TYPES.FORMAT;
      }

      // Capture previous state based on operation type
      if (state.type === OPERATION_TYPES.DELETE || state.type === OPERATION_TYPES.MODIFY) {
        const tool = this.getToolSchema(serverName, toolName);
        if (tool) {
          // Try to get current state before modification
          const result = await this.mcpHub.callTool(serverName, toolName.replace(/delete|modify/i, 'get'), {
            ...args,
            mode: 'read'
          });
          state.previousState = result;
        }
      }
      return state;
    } catch (error) {
      console.warn(`Failed to capture state for ${toolName}:`, error);
      return undefined;
    }
  }

  private async rollback(state: OperationState): Promise<RollbackResult> {
    try {
      if (!state.previousState) {
        return { success: false, error: 'No previous state available for rollback' };
      }

      switch (state.type) {
        case OPERATION_TYPES.DELETE: {
          // Recreate deleted data
          const createTool = state.toolName.replace(/delete|remove/i, 'create');
          if (this.toolSchemas.get(state.serverName)?.has(createTool)) {
            await this.mcpHub.callTool(state.serverName, createTool, {
              ...state.args,
              data: state.previousState
            });
          }
          break;
        }
        case OPERATION_TYPES.MODIFY: {
          // Restore previous content
          const restoreTool = state.toolName.replace(/write|modify/i, 'restore');
          if (this.toolSchemas.get(state.serverName)?.has(restoreTool)) {
            await this.mcpHub.callTool(state.serverName, restoreTool, {
              ...state.args,
              content: state.previousState
            });
          }
          break;
        }
        // Add other cases as needed
      }

      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error during rollback' 
      };
    }
  }

  /**
   * Check if a tool requires user confirmation
   */
  private requiresConfirmation(serverName: string, toolName: string): boolean {
    const tool = this.getToolSchema(serverName, toolName);
    if (!tool) return false;

    // Check explicit confirmation requirement
    if (tool.safety?.requiresConfirmation !== undefined) {
      return tool.safety.requiresConfirmation;
    }

    // Check danger level requirements
    const dangerLevel = this.getToolDangerLevel(tool);
    if (this.config.safetyConfig?.confirmationRequired?.dangerLevels?.includes(dangerLevel)) {
      return true;
    }

    // Check tool name patterns
    const patterns = this.config.safetyConfig?.confirmationRequired?.patterns ?? [];
    if (patterns.some(pattern => pattern.test(toolName))) {
      return true;
    }

    // Check specific tool names
    const tools = this.config.safetyConfig?.confirmationRequired?.tools ?? [];
    if (tools.includes(toolName)) {
      return true;
    }

    return this.isDangerousTool(tool);
  }

  /**
   * Get tool schema
   */
  private getToolSchema(serverName: string, toolName: string): Tool | undefined {
    return this.toolSchemas.get(serverName)?.get(toolName);
  }

  /**
   * Determine if a tool is potentially dangerous
   */
  private isDangerousTool(tool: Tool): boolean {
    // Check explicit safety metadata first
    if (tool.safety?.isDangerous) {
      return true;
    }

    // Check danger level
    if (tool.safety?.dangerLevel && tool.safety.dangerLevel !== 'none') {
      return true;
    }

    // Check tool name against dangerous keywords
    const toolName = tool.name.toLowerCase();
    const dangerousKeywords = [
      ...DANGEROUS_KEYWORDS,
      ...(this.config.safetyConfig?.dangerousKeywords ?? [])
    ];
    
    if (dangerousKeywords.some(keyword => toolName.includes(keyword.toLowerCase()))) {
      return true;
    }

    // Check if any required fields match dangerous patterns
    const requiredFields = tool.inputSchema.required ?? [];
    return requiredFields.some(field => 
      this.config.safetyConfig?.dangerousFields.includes(field)
    );
  }

  private getToolDangerLevel(tool: Tool): DangerLevel {
    // Use explicit danger level if provided
    if (tool.safety?.dangerLevel) {
      return tool.safety.dangerLevel;
    }

    // Determine danger level based on tool characteristics
    if (this.isDangerousTool(tool)) {
      // Check for high-risk operations
      const toolName = tool.name.toLowerCase();
      if (DANGEROUS_OPERATIONS[OPERATION_TYPES.DELETE].test(toolName)) {
        return 'high';
      }
      
      // Check for medium-risk operations
      if (DANGEROUS_OPERATIONS[OPERATION_TYPES.MODIFY].test(toolName) || 
          DANGEROUS_OPERATIONS[OPERATION_TYPES.EXECUTE].test(toolName)) {
        return 'medium';
      }

      // Default to low for other dangerous tools
      return 'low';
    }

    return 'none';
  }

  private getDangerousOperationType(operation: string): string | undefined {
    for (const [type, category] of Object.entries(DANGEROUS_CATEGORIES)) {
      if (category.operations.some(op => operation.toLowerCase().includes(op))) {
        return `${type}: ${category.description}`;
      }
    }
    return undefined;
  }

  /**
   * Get user confirmation for dangerous operations
   * Override this method to implement your UI-specific confirmation
   */
  protected async getUserConfirmation(
    serverName: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<boolean> {
    // Default implementation - override this in your application
    console.warn(
      `⚠️ Dangerous operation requested: ${serverName}/${toolName}`,
      'Arguments:', args
    );
    return false; // Default to rejecting dangerous operations
  }

  /**
   * Update server context
   */
  updateServerContext(serverName: string, context: Partial<ServerContextType>): void {
    const existingContext = this.serverContexts.get(serverName) || {
      type: 'default',
      config: {},  // Add required config property
      capabilities: {  // Move capability properties into capabilities object
        supportsRollback: false,
        maxConcurrentCalls: 1,
        supportedOperations: []
      },
      lastAccessed: new Date()
    };
    
    this.serverContexts.set(serverName, {
      ...existingContext,
      ...context,
      lastAccessed: new Date(), // Always update lastAccessed
      capabilities: existingContext.capabilities // Keep capabilities unchanged
    });
  }

  getStateManager(serverName: string): ServerStateManager {
    const context = this.serverContexts.get(serverName);
    if (!context) {
      // Create a default context with required properties
      const defaultContext: ServerContext = {
        type: 'default',
        config: {},  // Add required config property
        capabilities: {  // Move capability properties into capabilities object
          supportsRollback: false,
          maxConcurrentCalls: 1,
          supportedOperations: []
        },
        lastAccessed: new Date()
      };
      return new DefaultServerStateManager(serverName, defaultContext, this);
    }
    return new DefaultServerStateManager(serverName, context, this);
  }

  private getServerDefault(serverName: string, toolName: string, field: string): any {
    const context = this.serverContexts.get(serverName);
    if (!context?.config) return undefined;

    // Check tool-specific defaults first
    const toolDefaults = context.config[toolName];
    if (toolDefaults?.[field] !== undefined) {
      return toolDefaults[field];
    }

    // Check server-wide defaults
    return context.config[field];
  }

  /**
   * Validate and enrich arguments for a tool
   */
  private async validateAndEnrichArguments(
    serverName: string,
    tool: Tool,
    args: Record<string, any>
  ): Promise<{
    valid: boolean;
    enrichedArgs?: Record<string, any>;
    missingFields?: string[];
    error?: string;
  }> {
    const enrichedArgs = { ...args };
    const missingFields: string[] = [];

    // Validate required fields
    for (const [field, schema] of Object.entries(tool.inputSchema)) {
      if (enrichedArgs[field] === undefined) {
        // Quick lookup for default value
        const defaultValue = this.getServerDefault(serverName, tool.name, field);
        if (defaultValue !== undefined) {
          enrichedArgs[field] = defaultValue;
          continue;
        }

        if (schema) {
          missingFields.push(field);
        }
      }
    }
    return {
      valid: missingFields.length === 0,
      enrichedArgs: enrichedArgs,
      missingFields: missingFields.length > 0 ? missingFields : undefined
    };
  }
}