import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  InitializeResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadMcpConfig } from './config.mjs';
import { z } from 'zod';

interface ClientInfo {
  name: string;
  version: string;
  description?: string;
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  status: 'connected' | 'connecting' | 'disconnected';
  capabilities: ServerCapabilities;
  error?: string;
  activeToolCall?: {
    toolId: string;
    startTime: number;
  };
  lastSuccessfulConnection?: number;
}

interface ServerCapabilities {
  tools?: boolean;
  resources?: boolean;
  resourceTemplates?: boolean;
}

interface Tool {
  name: string;
  description?: string;
  inputSchema: any;
  serverName: string;
}

export class MCPHub {
  private static instance: MCPHub;
  private connections: Map<string, McpConnection> = new Map();
  private statusListeners: ((name: string, status: Omit<McpConnection, 'client' | 'transport'>) => void)[] = [];
  private toolCallQueue: Map<string, Array<{
    toolId: string;
    params: Record<string, any>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>> = new Map();

  private initialized = false;
  private config!: McpConfig;
  private allTools: Map<string, Tool[]> = new Map();
  private toolsInitialized = false;
  private connectionRetryAttempts: Map<string, number> = new Map();
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY = 1000; // 1 second
  private readonly CONNECTION_TIMEOUT = 10000; // 10 seconds
  private readonly MAX_CONCURRENT_OPERATIONS = 5;
  private activeOperationCount = 0;

  private constructor() {
    console.log('Creating new MCPHub instance.');
  }

  public static getInstance(): MCPHub {
    if (!MCPHub.instance) {
      MCPHub.instance = new MCPHub();
    } else {
      console.log('Returning existing MCPHub instance.');
    }
    return MCPHub.instance;
  }

  public get isInitialized(): boolean {
    return this.initialized;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn('MCPHub already initialized.');
      return;
    }

    this.config = await loadMcpConfig();
    if (!this.config.mcpServers) {
      this.initialized = true;
      console.warn('No MCP servers configured.');
      return;
    }

    try {
      console.log(
        'Initializing MCPHub with the following servers:',
        Object.keys(this.config.mcpServers),
      );

      await Promise.all(
        Object.entries(this.config.mcpServers).map(([name]) =>
          this.ensureConnection(name).catch((error) => {
            console.error(`Failed to connect to server ${name}:`, error);
          }),
        ),
      );
    } finally {
      this.initialized = true;
      console.log('MCPHub initialization complete.');
    }
  }

  private async ensureConnection(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (conn?.status === 'connected') {
      return;
    }

    const attempts = this.connectionRetryAttempts.get(name) || 0;
    if (attempts >= this.MAX_RETRY_ATTEMPTS) {
      throw new Error(`Max retry attempts (${this.MAX_RETRY_ATTEMPTS}) reached for server ${name}`);
    }

    try {
      await this.connectServer(name);
      this.connectionRetryAttempts.set(name, 0);
    } catch (error) {
      this.connectionRetryAttempts.set(name, attempts + 1);
      throw error;
    }
  }

  private async connectServer(name: string): Promise<void> {
    if (this.connections.has(name)) {
      console.log(`Disconnecting from existing server: ${name}`);
      await this.disconnectServer(name);
    }

    const client = new Client(
      {
        name: 'Srcbook',
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    const serverConfig = this.config.mcpServers[name];
    if (!serverConfig) {
      throw new Error(`No configuration found for server: ${name}`);
    }

    const filteredEnv: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(([_, val]) => val !== undefined),
    ) as Record<string, string>;

    const mergedEnv = {
      ...filteredEnv,
      ...(serverConfig.env || {}),
    };

    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      env: mergedEnv,
      stderr: 'pipe',
    });

    if (transport.stderr) {
      transport.stderr.on('data', (data: Buffer) => {
        console.error(`[${name} stderr] ${data.toString()}`);
      });
    }

    const conn: McpConnection = {
      client,
      transport,
      status: 'connecting',
      capabilities: {},
      lastSuccessfulConnection: undefined,
    };
    this.connections.set(name, conn);
    this.notifyStatusChange(name, conn);

    transport.onerror = async (error) => {
      if (conn.status !== 'disconnected') {
        conn.status = 'disconnected';
        conn.error = error.message;
        this.notifyStatusChange(name, conn);
        console.error(`Transport error for server ${name}:`, error.message);
      }
    };

    transport.onclose = async () => {
      if (conn.status !== 'disconnected') {
        conn.status = 'disconnected';
        conn.error = 'Transport closed unexpectedly.';
        this.notifyStatusChange(name, conn);
        console.warn(`Transport closed for server ${name}`);
      }
    };

    try {
      console.log(`Attempting to connect to server: ${name}`);
      console.log(
        `Command: ${serverConfig.command} ${serverConfig.args ? serverConfig.args.join(' ') : ''}`,
      );
      console.log(`Environment Variables:`, serverConfig.env || {});

      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Connection timeout for server ${name}`)), this.CONNECTION_TIMEOUT);
      });

      await Promise.race([connectPromise, timeoutPromise]);

      console.log(`Successfully connected to server: ${name}`);
      conn.status = 'connected';
      conn.error = undefined;
      conn.lastSuccessfulConnection = Date.now();
      this.notifyStatusChange(name, conn);

      const clientInfo: ClientInfo = {
        name: 'Srcbook',
        version: '1.0.0',
        description: 'Srcbook MCP Client',
      };

      const initializeResponse = await client.request(
        {
          method: 'initialize',
          params: {
            protocolVersion: '1.0',
            capabilities: {},
            clientInfo,
          },
        },
        InitializeResultSchema,
      );

      if (initializeResponse && initializeResponse.capabilities) {
        conn.capabilities = {
          tools: !!initializeResponse.capabilities.tools,
          resources: !!initializeResponse.capabilities.resources,
          resourceTemplates: !!initializeResponse.capabilities.resourceTemplates,
        };
        console.log(`Server ${name} capabilities:`, conn.capabilities);
      } else {
        console.warn(`No capabilities received from server ${name}.`);
      }

      if (conn.capabilities.tools) {
        try {
          const tools = await this.listTools(name);
          console.log(`Tools on server ${name}:`, tools);
          const toolsWithServer = tools.map(tool => ({
            ...tool,
            serverName: name
          }));
          this.allTools.set(name, toolsWithServer);
        } catch (error) {
          console.error(`Error listing tools on server ${name}:`, error);
        }
      }

      if (conn.capabilities.resources) {
        try {
          const resources = await this.listResources(name);
          console.log(`Resources on server ${name}:`, resources);
        } catch (error) {
          console.error(`Error listing resources on server ${name}:`, error);
        }
      }

      if (conn.capabilities.resourceTemplates) {
        try {
          const resourceTemplates = await this.listResourceTemplates(name);
          console.log(`Resource Templates on server ${name}:`, resourceTemplates);
        } catch (error) {
          console.error(`Error listing resource templates on server ${name}:`, error);
        }
      }
    } catch (err: any) {
      console.error(`Error connecting to server ${name}:`, err);
      conn.status = 'disconnected';
      conn.error = err instanceof Error ? err.message : String(err);
      this.notifyStatusChange(name, conn);
      throw err;
    }
  }

  private async disconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;

    try {
      await conn.transport.close();
      await conn.client.close();
      console.log(`Disconnected from server: ${name}`);
    } catch (error) {
      console.error(`Error disconnecting from server ${name}:`, error);
    }
    this.connections.delete(name);
  }

  private async enqueueToolCall(
    serverName: string, 
    toolId: string, 
    params: Record<string, any>
  ): Promise<any> {
    if (this.activeOperationCount >= this.MAX_CONCURRENT_OPERATIONS) {
      throw { type: 'overloaded_error', message: 'Too many concurrent operations. Please try again later.' };
    }

    return new Promise((resolve, reject) => {
      const queue = this.toolCallQueue.get(serverName) || [];
      queue.push({ toolId, params, resolve, reject });
      this.toolCallQueue.set(serverName, queue);

      if (queue.length === 1) {
        this.processNextToolCall(serverName);
      }
    });
  }

  private async processNextToolCall(serverName: string): Promise<void> {
    const queue = this.toolCallQueue.get(serverName) || [];
    const currentCall = queue[0];
    if (!currentCall) return;

    const conn = this.connections.get(serverName);
    if (!conn) {
      currentCall.reject(new Error(`No connection found for server: ${serverName}`));
      return;
    }

    try {
      this.activeOperationCount++;
      console.log(`[${new Date().toISOString()}] 🔧 Executing tool call:`, {
        serverName,
        toolId: currentCall.toolId,
        transportStatus: conn.status,
        connectionStatus: conn.status
      });

      const result = await conn.client.callTool({
        name: currentCall.toolId,
        arguments: currentCall.params,
      });
      currentCall.resolve(result);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Tool call error:`, {
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : error,
        serverName,
        toolId: currentCall.toolId,
        transportStatus: conn.status,
        connectionStatus: conn.status
      });
      currentCall.reject(error as Error);
    } finally {
      this.activeOperationCount--;
      queue.shift();
      this.toolCallQueue.set(serverName, queue);
      
      if (queue.length > 0) {
        await this.processNextToolCall(serverName);
      }
    }
  }

  async callTool(
    serverName: string,
    toolId: string,
    params: Record<string, any>
  ): Promise<any> {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] 📝 Tool call requested:`, {
      serverName,
      toolId,
      params: JSON.stringify(params, null, 2)
    });

    // Import trackOperation function
    const { trackOperation } = await import('../dev-server.mjs');

    // Create a promise for the entire operation
    const operation = (async () => {
      // Get or establish connection
      let conn = this.connections.get(serverName);
      if (!conn || conn.status !== 'connected') {
        try {
          await this.ensureConnection(serverName);
          conn = this.connections.get(serverName);
        } catch (error) {
          const errorMsg = `Failed to establish connection to server ${serverName}: ${error instanceof Error ? error.message : String(error)}`;
          console.error(`[${timestamp}] ❌ ${errorMsg}`);
          throw new Error(errorMsg);
        }
      }

      if (!conn || conn.status !== 'connected') {
        const error = `Server ${serverName} is not connected. Status: ${conn?.status || 'unknown'}`;
        console.error(`[${timestamp}] ❌ ${error}`);
        throw new Error(error);
      }

      // Validate and get tool
      const tools = await this.listTools(serverName);
      const tool = tools.find(t => t.name === toolId);
      if (!tool) {
        const error = `Tool '${toolId}' not found on server ${serverName}. Available tools: ${tools.map(t => t.name).join(', ')}`;
        console.error(`[${timestamp}] ❌ ${error}`);
        throw new Error(error);
      }

      // Execute tool call with retry logic
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < this.MAX_RETRY_ATTEMPTS; attempt++) {
        try {
          console.log(`[${timestamp}] 🔄 Attempting tool call (attempt ${attempt + 1}/${this.MAX_RETRY_ATTEMPTS})`);
          const result = await this.enqueueToolCall(serverName, toolId, params);
          console.log(`[${timestamp}] ✅ Tool call completed:`, {
            serverName,
            toolId,
            result: typeof result === 'object' ? JSON.stringify(result, null, 2) : result
          });
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.error(`[${timestamp}] ⚠️ Tool call attempt ${attempt + 1} failed:`, {
            error: lastError,
            willRetry: attempt < this.MAX_RETRY_ATTEMPTS - 1
          });

          if (attempt < this.MAX_RETRY_ATTEMPTS - 1) {
            await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
            // Try to re-establish connection if needed
            await this.ensureConnection(serverName);
          }
        }
      }

      // If we get here, all attempts failed
      const enhancedError = new Error(
        `Failed to execute tool '${toolId}' on server '${serverName}' after ${this.MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message}\n` +
        `Server status: ${conn.status}\n` +
        `Connection error: ${conn.error || 'none'}`
      );
      throw enhancedError;
    })();

    // Track the operation
    trackOperation(operation);

    // Return the operation result
    return operation;
  }

  async listTools(serverName: string): Promise<z.infer<typeof ListToolsResultSchema>['tools']> {
    const conn = this.connections.get(serverName);
    if (!conn || conn.status !== 'connected') {
      console.warn(`Cannot list tools. Server ${serverName} is not connected.`);
      return [];
    }

    if (!conn.capabilities.tools) {
      console.log(`Server ${serverName} does not support tools. Skipping tools listing.`);
      return [];
    }

    console.log(`Requesting tools list from server ${serverName}...`);

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await conn.client.request({ method: 'tools/list' }, ListToolsResultSchema);
      clearTimeout(timeout);
      console.log(`Received tools list from server ${serverName}:`, response.tools);
      return response.tools || [];
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        console.error(`Timeout while listing tools on server ${serverName}.`);
      } else {
        console.error(`Error listing tools on server ${serverName}:`, error);
      }
      return [];
    }
  }

  async listResources(
    serverName: string,
  ): Promise<z.infer<typeof ListResourcesResultSchema>['resources']> {
    const conn = this.connections.get(serverName);
    if (!conn || conn.status !== 'connected') {
      return [];
    }

    if (!conn.capabilities.resources) {
      console.log(`Server ${serverName} does not support resources. Skipping resources listing.`);
      return [];
    }

    try {
      const response = await conn.client.request(
        { method: 'resources/list' },
        ListResourcesResultSchema,
      );
      return response.resources || [];
    } catch (error: any) {
      if (error.code === -32601) {
        console.warn(`Method 'resources/list' not found on server ${serverName}.`);
      } else {
        console.error(`Error listing resources on server ${serverName}:`, error);
      }
      return [];
    }
  }

  async listResourceTemplates(serverName: string): Promise<any[]> {
    const conn = this.connections.get(serverName);
    if (!conn || conn.status !== 'connected') {
      return [];
    }

    if (!conn.capabilities.resourceTemplates) {
      console.log(`Server ${serverName} does not support resource templates. Skipping.`);
      return [];
    }

    try {
      const response = await conn.client.request(
        { method: 'resources/templates/list' },
        ListResourceTemplatesResultSchema,
      );
      return response?.resourceTemplates || [];
    } catch (error: any) {
      if (error.code === -32601) {
        console.warn(`Method 'resources/templates/list' not found on server ${serverName}.`);
      } else {
        console.error(`Error listing resource templates on server ${serverName}:`, error);
      }
      return [];
    }
  }

  listConnections(): Array<{
    name: string;
    status: string;
    capabilities: ServerCapabilities;
    error?: string;
  }> {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      name,
      status: conn.status,
      capabilities: conn.capabilities,
      error: conn.error,
    }));
  }

  getConnection(name: string): McpConnection | undefined {
    return this.connections.get(name);
  }

  async reconnectServer(name: string): Promise<void> {
    const serverConfig = this.config.mcpServers[name];
    if (!serverConfig) {
      throw new Error(`No configuration found for server: ${name}`);
    }
    await this.ensureConnection(name);
  }

  onStatusChange(
    listener: (name: string, status: Omit<McpConnection, 'client' | 'transport'>) => void,
  ) {
    this.statusListeners.push(listener);
  }

  private notifyStatusChange(name: string, conn: McpConnection) {
    const status = {
      name,
      status: conn.status,
      error: conn.error,
      capabilities: conn.capabilities,
    };

    for (const listener of this.statusListeners) {
      listener(name, status);
    }
  }

  private async initializeTools(): Promise<void> {
    if (this.toolsInitialized) return;

    const connections = await this.listConnections();
    for (const server of connections) {
      if (server.capabilities.tools) {
        try {
          const tools = await this.listTools(server.name);
          const toolsWithServer = tools.map(tool => ({
            ...tool,
            serverName: server.name
          }));
          this.allTools.set(server.name, toolsWithServer);
        } catch (error) {
          console.error(`Failed to initialize tools for server ${server.name}:`, error);
          this.allTools.set(server.name, []);
        }
      }
    }

    this.toolsInitialized = true;
  }

  public getAllTools(): Tool[] {
    return Array.from(this.allTools.values()).flat();
  }

  public getToolsByServer(serverName: string): Tool[] {
    return this.allTools.get(serverName) || [];
  }

  public findTool(serverName: string, toolName: string): Tool | undefined {
    const serverTools = this.allTools.get(serverName);
    return serverTools?.find(tool => tool.name === toolName);
  }
}

const mcpHubInstance = MCPHub.getInstance();
export default mcpHubInstance;
