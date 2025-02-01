import http from 'node:http';
import { WebSocketServer as WsWebSocketServer } from 'ws';
import mcpHubInstance from './mcp/mcphub.mjs';
import app from './server/http.mjs';
import webSocketServer from './server/ws.mjs';
import { initializeToolExecutor } from './ai/tool-executor-singleton.mjs';

export { SRCBOOK_DIR } from './constants.mjs';

const server = http.createServer(app);
const wss = new WsWebSocketServer({ server });
wss.on('connection', webSocketServer.onConnection);

const port = process.env.PORT || 2150;

let activeOperations = new Set();

// Initialize MCPHub before starting the server
(async () => {
  try {
    await mcpHubInstance.initialize();
    console.log('MCPHub initialized successfully');
    
    await initializeToolExecutor(mcpHubInstance);
    console.log('Tool executor initialized successfully');

    server.listen(port, () => {
      console.log(`Server is running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to initialize MCPHub:', error);
    process.exit(1);
  }
})();

process.on('SIGINT', async function () {
  // Wait for active operations to complete
  if (activeOperations.size > 0) {
    console.log('Waiting for active operations to complete...');
    await Promise.all(Array.from(activeOperations));
  }
  server.close();
  process.exit();
});

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', async () => {
    // Wait for active operations to complete
    if (activeOperations.size > 0) {
      console.log('Waiting for active operations to complete before HMR...');
      await Promise.all(Array.from(activeOperations));
    }
    wss.close();
    server.close();
  });

  import.meta.hot.dispose(async () => {
    // Wait for active operations to complete
    if (activeOperations.size > 0) {
      console.log('Waiting for active operations to complete before dispose...');
      await Promise.all(Array.from(activeOperations));
    }
    wss.close();
    server.close();
  });
}

// Export for use in other modules
export function trackOperation(operation: Promise<any>) {
  activeOperations.add(operation);
  operation.catch(error => {
    if (error?.type === 'overloaded_error') {
      console.warn('Operation rejected due to overload:', error.message);
    } else {
      console.error('Operation failed:', error);
    }
  }).finally(() => {
    activeOperations.delete(operation);
  });
}
