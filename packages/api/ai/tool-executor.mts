import { MCPHub } from '../mcp/mcphub.mjs';
import { McpTool, McpToolSchema } from '../mcp/types/index.mjs';
import { generateText } from 'ai';
import { getModel } from './config.mjs';
import { LLMPromptContext, LLMPromptResult } from '../mcp/types/index.mjs';

type Tool = McpTool;

interface ServerContext {
  defaultConfig?: Record<string, any>;
  dangerousTools?: Set<string>;
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
}

interface ToolExecutorConfig {
  maxRetries?: number;
  llmEnabled?: boolean;
}

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
      ...config
    };

    if (defaultConfigs) {
      Object.entries(defaultConfigs).forEach(([serverName, config]) => {
        this.serverContexts.set(serverName, { defaultConfig: config });
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
          const context = this.serverContexts.get(serverName) || {};
          context.dangerousTools = context.dangerousTools || new Set();
          context.dangerousTools.add(tool.name);
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

    while (attempts < this.config.maxRetries!) {
      try {
        const tool = this.getToolSchema(serverName, toolName);
        if (!tool) {
          return {
            success: false,
            error: `Tool not found: ${serverName}/${toolName}`
          };
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
        const { isValid, finalArgs, missingFields } = this.validateAndInjectArgs(
          serverName,
          tool,
          currentArgs
        );

        if (!isValid && this.config.llmEnabled && missingFields) {
          // Try to get missing fields from LLM
          const promptContext: LLMPromptContext = {
            serverName,
            toolName,
            missingFields: missingFields.map(field => ({
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

        if (!isValid) {
          return {
            success: false,
            missingFields,
            error: `Missing required fields: ${missingFields?.join(', ')}`
          };
        }

        // Execute the tool
        const result = await this.mcpHub.callTool(serverName, toolName, finalArgs);

        return {
          success: true,
          data: result as T,
        };

      } catch (error) {
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

Respond in JSON format with:
{
  "providedValues": {}, // Record of field names to values you can determine
  "shouldPromptUser": boolean, // true if user input is needed
  "userPrompt": string // if shouldPromptUser is true, provide a clear prompt
}`
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      try {
        return JSON.parse(response.text) as LLMPromptResult;
      } catch (e) {
        return {
          providedValues: {},
          shouldPromptUser: true,
          userPrompt: 'Failed to parse LLM response, please provide the missing fields manually'
        };
      }
    } catch (e) {
      return {
        providedValues: {},
        shouldPromptUser: true,
        userPrompt: 'Failed to get LLM suggestions, please provide the missing fields manually'
      };
    }
  }

  /**
   * Build prompt for LLM
   */
  private buildLLMPrompt(context: LLMPromptContext): string {
    const { serverName, toolName, missingFields, currentArgs, attemptCount } = context;
    
    return `Tool: ${serverName}/${toolName}
Current Arguments: ${JSON.stringify(currentArgs, null, 2)}

Missing Fields:
${missingFields.map(f => `- ${f.name} (${f.type})${f.description ? ': ' + f.description : ''}`).join('\n')}

Attempt: ${attemptCount + 1}

Please provide values for the missing fields if you can determine them from context.
If user input is required, explain what information is needed and why.`;
  }

  /**
   * Validate arguments and inject defaults where possible
   */
  private validateAndInjectArgs(
    serverName: string,
    tool: Tool,
    args: Record<string, any>
  ): { isValid: boolean; finalArgs: Record<string, any>; missingFields?: string[] } {
    const finalArgs = { ...args };
    const missingFields: string[] = [];

    // Check required fields
    const requiredFields = tool.inputSchema.required || [];
    for (const field of requiredFields) {
      if (finalArgs[field] === undefined) {
        // Try to inject from default config
        const defaultValue = this.getDefaultValue(serverName, field);
        if (defaultValue !== undefined) {
          finalArgs[field] = defaultValue;
        } else {
          missingFields.push(field);
        }
      }
    }

    return {
      isValid: missingFields.length === 0,
      finalArgs,
      missingFields: missingFields.length > 0 ? missingFields : undefined
    };
  }

  /**
   * Check if a tool requires user confirmation
   */
  private requiresConfirmation(serverName: string, toolName: string): boolean {
    const context = this.serverContexts.get(serverName);
    return context?.dangerousTools?.has(toolName) || false;
  }

  /**
   * Get default value for a field from server context
   */
  private getDefaultValue(serverName: string, field: string): any {
    const context = this.serverContexts.get(serverName);
    return context?.defaultConfig?.[field];
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
    const dangerousPatterns = [
      /delete/i,
      /remove/i,
      /drop/i,
      /push/i,
      /write/i,
      /modify/i
    ];

    return (
      dangerousPatterns.some(pattern => pattern.test(tool.name)) ||
      (tool.description ? tool.description.toLowerCase().includes('dangerous') : false)
    );
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
  updateServerContext(serverName: string, context: Partial<ServerContext>): void {
    const current = this.serverContexts.get(serverName) || {};
    this.serverContexts.set(serverName, {
      ...current,
      ...context
    });
  }
}