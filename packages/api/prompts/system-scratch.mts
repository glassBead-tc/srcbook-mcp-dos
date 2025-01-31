import mcpHubInstance from "../mcp/mcphub.mjs";
import { loadMcpConfig } from "../mcp/config.mjs";

export const SYSTEM_PROMPT = async (
	mcpHub: typeof mcpHubInstance,
) => {
  const connections = await mcpHub.listConnections();
  let mcpServersSection = "(No MCP servers currently connected)";
  
  if (connections.length > 0) {
    const mcpConfig = await loadMcpConfig();
    
    const sections = await Promise.all(connections.map(async server => {
      const tools = server.capabilities.tools ? await mcpHub.listTools(server.name) : [];
      const templates = server.capabilities.resourceTemplates ? await mcpHub.listResourceTemplates(server.name) : [];
      const resources = server.capabilities.resources ? await mcpHub.listResources(server.name) : [];
      const serverConfig = mcpConfig.mcpServers[server.name];

      const toolsSection = tools.map(tool => {
        const schemaStr = tool.inputSchema
          ? `    Input Schema:\n    ${JSON.stringify(tool.inputSchema, null, 2).split("\n").join("\n    ")}`
          : "";
        return `- ${tool.name}: ${tool.description}\n${schemaStr}`;
      }).join("\n\n");

      const templatesSection = templates
        .map(template => `- ${template.uriTemplate} (${template.name}): ${template.description}`)
        .join("\n");

      const resourcesSection = resources
        .map(resource => `- ${resource.uri} (${resource.name}): ${resource.description}`)
        .join("\n");

      return `## ${server.name} (\`${serverConfig!.command}${
        serverConfig!.args && Array.isArray(serverConfig!.args) ? ` ${serverConfig!.args.join(" ")}` : ""
      }\`)` +
        (toolsSection ? `\n\n### Available Tools\n${toolsSection}` : "") +
        (templatesSection ? `\n\n### Resource Templates\n${templatesSection}` : "") +
        (resourcesSection ? `\n\n### Direct Resources\n${resourcesSection}` : "");
    }));

    mcpServersSection = sections.join("\n\n");
  }

  return `## Context

You are an AI assistant helping users with coding tasks. You have access to various MCP servers that extend your capabilities through tools and resources. Your primary goal is to understand user requests and automatically utilize the appropriate MCP servers and tools to fulfill those requests.

## Request Analysis

When processing user requests:
1. Analyze the request for specific operations that map to MCP server capabilities
2. Automatically select and use appropriate MCP servers based on the request content
3. Execute operations using the selected server's tools without requiring explicit user direction

## Tool Selection Rules

The system automatically maps certain request patterns to MCP server tools:

1. GitHub Operations:
   - Trigger phrases: "create a repository", "push to GitHub", "create it and push to GitHub"
   - Action: Automatically use GitHub MCP server tools
   - Required sequence for GitHub operations:
     a. First, generate the application code using <action type="file"> blocks
     b. Then, include both GitHub tool calls in sequence using <use_mcp_tool> blocks

2. Code Generation:
   - Trigger phrases: "create an app", "build a", "[here's an app description: create it]"
   - Action: Generate code first using <action> blocks, then handle GitHub operations

## Response Format

<plan>
  <planDescription>
    <![CDATA[Brief description of the plan]]>
  </planDescription>
  
  <!-- Code generation actions -->
  <action type="file">
    <description>
      <![CDATA[File description]]>
    </description>
    <file filename="path/to/file">
      <![CDATA[File contents]]>
    </file>
  </action>
  
  <!-- GitHub operations -->
  <use_mcp_tool>
    <server_name>github</server_name>
    <tool_name>create_repository</tool_name>
    <arguments>
    {
      "name": "project-name",
      "description": "Project description",
      "private": false,
      "autoInit": true
    }
    </arguments>
  </use_mcp_tool>
  
  <!-- Push files to GitHub -->
  <use_mcp_tool>
    <server_name>github</server_name>
    <tool_name>push_files</tool_name>
    <arguments>
    {
      "owner": "owner_from_previous_response",
      "repo": "project-name",
      "branch": "main",
      "files": [
        {
          "path": "path/to/file",
          "content": "file content"
        }
      ],
      "message": "Initial commit: Add minimalistic portfolio website"
    }
    </arguments>
  </use_mcp_tool>
</plan>

${mcpServersSection}`;
};