import { MCPHub } from '../mcp/mcphub.mjs';
import { DangerLevel, McpTool, McpToolSchema } from '../mcp/types/index.mjs';

/**
 * Base class for tool executors with extensible safety checks
 */
export class BaseToolExecutor {
  protected toolSchemas: Map<string, Map<string, McpTool>>;

  constructor(
    protected mcpHub: MCPHub,
    protected defaultConfigs?: Record<string, Record<string, any>>
  ) {
    this.toolSchemas = new Map();
  }

  /**
   * Initialize tool schemas from server
   */
  async initializeServerTools(serverName: string): Promise<void> {
    try {
      const rawTools = await this.mcpHub.listTools(serverName);
      const serverTools = new Map<string, McpTool>();
      rawTools.forEach(rawTool => {
        const tool = McpToolSchema.parse(rawTool);
        serverTools.set(tool.name, tool);
      });
      this.toolSchemas.set(serverName, serverTools);
      console.log(`Server ${serverName} tools initialized successfully`);
    } catch (error) {
      console.error(`Failed to initialize tools for server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Override this to customize dangerous tool detection
   */
  protected isDangerousTool(serverName: string, tool: McpTool): boolean {
    // By default, consider write/create/modify operations as dangerous
    const dangerousPatterns = [
      /write/i,
      /create/i,
      /modify/i,
      /delete/i,
      /remove/i,
      /push/i
    ];

    return dangerousPatterns.some(pattern => pattern.test(tool.name));
  }

  /**
   * Override this to customize danger level assessment
   */
  protected getToolDangerLevel(serverName: string, tool: McpTool): DangerLevel {
    if (!this.isDangerousTool(serverName, tool)) {
      return 'none';
    }

    // By default, categorize based on operation type
    const toolName = tool.name.toLowerCase();
    if (toolName.includes('delete') || toolName.includes('remove')) {
      return 'high';
    }
    if (toolName.includes('modify') || toolName.includes('update')) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Override this to customize operation validation
   */
  protected async validateOperation(
    serverName: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<boolean> {
    // By default, allow all operations
    return true;
  }

  /**
   * Execute a tool with safety checks
   */
  async executeTool(params: {
    serverName: string;
    toolName: string;
    arguments: Record<string, any>;
  }): Promise<any> {
    // Validate the operation
    const isValid = await this.validateOperation(
      params.serverName,
      params.toolName,
      params.arguments
    );
    if (!isValid) {
      throw new Error(
        `Operation validation failed for ${params.serverName}/${params.toolName}`
      );
    }

    // Execute the tool
    return this.mcpHub.callTool(
      params.serverName,
      params.toolName,
      params.arguments
    );
  }
}
