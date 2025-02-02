import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@srcbook/components/src/components/ui/dropdown-menu';
import { Button } from '@srcbook/components/src/components/ui/button';

type MCPTool = {
  name: string;
  description: string;
  server: string;
};

type MCPToolsCounterProps = {
  tools: MCPTool[];
  isLoading?: boolean;
};

export function MCPToolsCounter({ tools, isLoading = false }: MCPToolsCounterProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="ghost" 
          size="sm" 
          className="h-6 px-2 text-xs font-medium bg-secondary hover:bg-secondary/80"
        >
          {isLoading ? "Loading..." : `${tools.length} MCP tools`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[400px] max-h-[400px] overflow-y-auto">
        <div className="px-3 py-2 text-sm">
          Claude can use tools provided by specialized servers using Model Context Protocol.{' '}
          <a 
            href="https://github.com/srcbook/mcp" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-blue-500 hover:underline"
          >
            Learn more about MCP
          </a>
        </div>
        {isLoading ? (
          <div className="p-4 text-center text-muted-foreground">Loading available tools...</div>
        ) : (
          <div className="border-t border-border">
          {tools.map((tool) => (
            <DropdownMenuItem 
              key={`${tool.server}-${tool.name}`} 
              className="flex flex-col items-start py-2 px-3 cursor-default"
            >
              <div className="font-medium">{tool.name}</div>
              {tool.description && (
                <div className="text-sm text-muted-foreground mt-1">{tool.description}</div>
              )}
              <div className="text-xs text-muted-foreground/60 mt-1">From server: {tool.server}</div>
            </DropdownMenuItem>
          ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
