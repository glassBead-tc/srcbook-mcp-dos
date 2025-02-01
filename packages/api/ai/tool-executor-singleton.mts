import { BaseToolExecutor } from './tool-executor-base.mjs';
import { GitHubToolExecutor } from '../mcp/executors/github.mjs';

// Make these module-level variables to persist across HMR
let toolExecutorInstance: BaseToolExecutor | undefined;
let toolExecutorInitializedResolve: (() => void) | undefined;
export const toolExecutorInitialized = new Promise<void>(resolve => {
  toolExecutorInitializedResolve = resolve;
});

export async function initializeToolExecutor(mcpHub: any) {
  // If we already have an instance during HMR, don't recreate
  if (toolExecutorInstance) {
    console.log('ToolExecutor instance already exists (HMR).');
    return;
  }

  toolExecutorInstance = new BaseToolExecutor(mcpHub);
  console.log('ToolExecutor instance created.');
  
  // Initialize the server tools before resolving the promise
  // Initialize tools for all configured servers
  const config = await mcpHub.listConnections();
  for (const server of config) {
    await toolExecutorInstance.initializeServerTools(server.name);
    console.log(`${server.name} server tools initialized.`);
  }
  
  toolExecutorInitializedResolve && toolExecutorInitializedResolve();
  console.log('ToolExecutor fully initialized.');
}

export async function getToolExecutor(): Promise<BaseToolExecutor> {
  if (!toolExecutorInstance) {
    await toolExecutorInitialized;  // Wait if not ready yet
    if (!toolExecutorInstance) {
      throw new Error("ToolExecutor still not initialized.");
    }
  }
  return toolExecutorInstance;
}

// Handle HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    console.log('HMR: Preserving ToolExecutor instance');
  });
}
