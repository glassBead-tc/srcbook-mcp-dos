import { BaseToolExecutor } from '../../ai/tool-executor-base.mjs';
import { McpTool, DangerLevel } from '../types/index.mjs';
import { GitHubServerContext } from '../types/servers/github.mjs';

/**
 * GitHubToolExecutor extends BaseToolExecutor with GitHub-specific handling
 */
export class GitHubToolExecutor extends BaseToolExecutor {
  /**
   * Override validateOperation to handle GitHub operations
   */
  protected async validateOperation(
    serverName: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<boolean> {
    // Only handle GitHub operations
    if (serverName !== 'github') {
      return true;
    }

    // Validate GitHub-specific operations
    switch (toolName) {
      case 'create_repository':
        return this.validateCreateRepository(args);
      
      case 'push_files':
      case 'create_or_update_file':
        return this.validateFileOperation(args);
      
      case 'create_issue':
      case 'create_pull_request':
      case 'search_repositories':
      case 'search_code':
      case 'search_issues':
      case 'get_file_contents':
      case 'list_commits':
        // Allow these operations by default
        return true;
      
      default:
        // For unknown operations, allow them but log for monitoring
        console.log(`Allowing unknown GitHub operation: ${toolName}`);
        return true;
    }
  }

  /**
   * Override isDangerousTool for GitHub-specific danger assessment
   */
  protected isDangerousTool(serverName: string, tool: McpTool): boolean {
    // Only apply GitHub-specific rules for GitHub server
    if (serverName !== 'github') {
      return super.isDangerousTool(serverName, tool);
    }

    // Read-only operations are never dangerous
    const safeOperations = [
      'search',
      'get',
      'list'
    ];

    if (safeOperations.some(op => tool.name.toLowerCase().includes(op))) {
      return false;
    }

    // For other operations, use base implementation
    return super.isDangerousTool(serverName, tool);
  }

  /**
   * Override getToolDangerLevel for GitHub-specific danger levels
   */
  protected getToolDangerLevel(serverName: string, tool: McpTool): DangerLevel {
    // Only apply GitHub-specific rules for GitHub server
    if (serverName !== 'github') {
      return super.getToolDangerLevel(serverName, tool);
    }

    const toolName = tool.name.toLowerCase();
    
    // Repository operations are medium risk
    if (toolName.includes('repository')) {
      return 'medium';
    }

    // File operations are low risk
    if (toolName.includes('file')) {
      return 'low';
    }

    // Use base implementation for other operations
    return super.getToolDangerLevel(serverName, tool);
  }

  /**
   * Validate repository creation arguments
   */
  protected validateCreateRepository(args: Record<string, any>): boolean {
    // Required fields
    if (!args.name) {
      console.error('Repository name is required');
      return false;
    }

    // Validate repository name format
    const nameRegex = /^[a-zA-Z0-9._-]+$/;
    if (!nameRegex.test(args.name)) {
      console.error('Invalid repository name format');
      return false;
    }

    return true;
  }

  /**
   * Validate file operation arguments
   */
  protected validateFileOperation(args: Record<string, any>): boolean {
    // Required fields for file operations
    if (!args.owner || !args.repo) {
      console.error('Owner and repository name are required');
      return false;
    }

    if (Array.isArray(args.files)) {
      // Validate multiple files
      return args.files.every((file: any) => 
        file.path && typeof file.content === 'string'
      );
    } else if (args.path) {
      // Validate single file
      return typeof args.content === 'string';
    }

    return false;
  }
}
