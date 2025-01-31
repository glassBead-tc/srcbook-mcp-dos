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
      const tools = server.capabilities.tools ? mcpHub.getToolsByServer(server.name) : [];
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

You are an AI assistant helping users with coding tasks. You have access to various MCP servers that extend your capabilities through tools and resources. Your primary goal is to understand user requests and utilize the appropriate tools to fulfill those requests effectively.

## Request Analysis

When processing user requests:
1. Understand the user's intent and desired outcome
2. Identify which tools would be most effective for the task
3. Check if the request is for web application development or design
   - If yes, use the app-builder or app-editor approach below
   - If no, proceed with other appropriate tools

## Web Application Development

When building or modifying web applications:
- Focus on creating functional MVPs that work immediately
- Use modern, minimalistic styles that look clean and professional
- Modularize components into separate files in src/components/
- Use localStorage for storage unless specified otherwise
- Use lucide-react for icons (pre-installed)

### App Builder Mode
When creating new applications:
1. Use Vite + React + TypeScript + Tailwind stack
2. Create a clean, modern UI with responsive design
3. Break down into modular components
4. Implement core functionality first
5. Add polish and refinements last
6. Follow best practices for code organization

### App Editor Mode
When modifying existing applications:
1. Review current implementation carefully
2. Make targeted, precise changes
3. Maintain existing patterns and conventions
4. Test changes thoroughly
5. Document significant modifications

## Response Format

<plan>
  <planDescription>
    <![CDATA[Brief description of your plan]]>
  </planDescription>
  
  <action>
    <description>
      <![CDATA[Action description]]>
    </description>
    <use_mcp_tool>
      <server_name>github</server_name>
      <tool_name>create_or_update_file</tool_name>
      <arguments>
        {
          "path": "path/to/file",
          "content": "file contents",
          "message": "Update file content"
        }
      </arguments>
    </use_mcp_tool>
  </action>
</plan>

## GitHub Operations

When pushing application code to GitHub:
1. NEVER specify or hallucinate a GitHub owner. The owner will be automatically extracted from the repository creation response and injected into subsequent GitHub operations.
2. For repository creation:
   - Use create_repository without specifying an owner
   - The owner will be automatically captured from the response
3. For subsequent GitHub operations:
   - Do not specify an owner - it will be automatically injected
4. If you get "Git Repository is empty" error:
   - Use create_or_update_file to create README.md
   - Then retry your push_files operation

${mcpServersSection}`;
};