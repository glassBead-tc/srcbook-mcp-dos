import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { ComposedToolSchema } from './types.mjs';
import compositionExecutor from './executor.mjs';

const CONFIG_FILENAME = 'composed-tools.json';
const CONFIG_PATHS = [
  // User config directory
  join(homedir(), '.srcbook', CONFIG_FILENAME),
  // Project config directory
  join(process.cwd(), '.srcbook', CONFIG_FILENAME),
  // Built-in config directory
  join(__dirname, 'tools', CONFIG_FILENAME)
];

const ConfigSchema = z.object({
  tools: z.array(ComposedToolSchema)
});

/**
 * Load composed tool configurations from various locations
 */
export async function loadComposedTools(): Promise<void> {
  for (const configPath of CONFIG_PATHS) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const config = ConfigSchema.parse(JSON.parse(content));

      // Register each tool with the executor
      for (const tool of config.tools) {
        try {
          compositionExecutor.registerTool(tool);
          console.log(`Registered composed tool: ${tool.name}`);
        } catch (error) {
          console.error(`Failed to register tool ${tool.name}:`, error);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Error loading composed tools from ${configPath}:`, error);
      }
    }
  }
}

/**
 * Example composed tool configuration:
 * {
 *   "tools": [{
 *     "name": "deploy_web_app",
 *     "description": "Deploy a web application with GitHub and filesystem operations",
 *     "version": "1.0.0",
 *     "inputSchema": {
 *       "type": "object",
 *       "properties": {
 *         "buildDir": { "type": "string" },
 *         "repo": { "type": "string" },
 *         "version": { "type": "string" }
 *       },
 *       "required": ["buildDir", "repo", "version"]
 *     },
 *     "steps": [
 *       {
 *         "name": "read_build",
 *         "server": "filesystem",
 *         "tool": "read_directory",
 *         "input": {
 *           "path": {
 *             "type": "reference",
 *             "source": {
 *               "type": "param",
 *               "path": "buildDir"
 *             }
 *           }
 *         },
 *         "output": "buildFiles"
 *       },
 *       {
 *         "name": "create_release",
 *         "server": "github",
 *         "tool": "create_release",
 *         "input": {
 *           "repo": {
 *             "type": "reference",
 *             "source": {
 *               "type": "param",
 *               "path": "repo"
 *             }
 *           },
 *           "tag": {
 *             "type": "reference",
 *             "source": {
 *               "type": "param",
 *               "path": "version"
 *             }
 *           },
 *           "files": {
 *             "type": "reference",
 *             "source": {
 *               "type": "output",
 *               "stepName": "read_build",
 *               "path": "buildFiles"
 *             }
 *           }
 *         },
 *         "output": "release",
 *         "rollback": {
 *           "server": "github",
 *           "tool": "delete_release",
 *           "input": {
 *             "repo": {
 *               "type": "reference",
 *               "source": {
 *                 "type": "param",
 *                 "path": "repo"
 *               }
 *             },
 *             "tag": {
 *               "type": "reference",
 *               "source": {
 *                 "type": "param",
 *                 "path": "version"
 *               }
 *             }
 *           }
 *         }
 *       },
 *       {
 *         "name": "update_pages",
 *         "server": "github",
 *         "tool": "update_pages",
 *         "input": {
 *           "repo": {
 *             "type": "reference",
 *             "source": {
 *               "type": "param",
 *               "path": "repo"
 *             }
 *           },
 *           "branch": "gh-pages",
 *           "files": {
 *             "type": "reference",
 *             "source": {
 *               "type": "output",
 *               "stepName": "read_build",
 *               "path": "buildFiles"
 *             }
 *           }
 *         },
 *         "condition": {
 *           "type": "success",
 *           "stepName": "create_release"
 *         }
 *       }
 *     ]
 *   }]
 * }
 */
