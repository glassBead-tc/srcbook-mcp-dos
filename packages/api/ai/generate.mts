import { streamText, generateText, type GenerateTextResult } from 'ai';
import { getModel } from './config.mjs';
import {
  type CodeLanguageType,
  type CellType,
  type CodeCellType,
  randomid,
  type CellWithPlaceholderType,
} from '@srcbook/shared';
import { type SessionType } from '../types.mjs';
import { readFileSync } from 'node:fs';
import Path from 'node:path';
import { PROMPTS_DIR } from '../constants.mjs';
import { encode, decodeCells } from '../srcmd.mjs';
import { buildProjectXml, type FileContent } from '../ai/app-parser.mjs';
import { logAppGeneration } from './logger.mjs';
import mcpHubInstance from '../mcp/mcphub.mjs';
import { SYSTEM_PROMPT } from "../prompts/system-scratch.mjs";
import { McpToolCallResponse } from '../mcp/types/index.mjs';
import { ToolExecutor } from './tool-executor.mjs';

console.log('MCPHub instance:', mcpHubInstance);

const makeGenerateSrcbookSystemPrompt = () => {
  return readFileSync(Path.join(PROMPTS_DIR, 'srcbook-generator.txt'), 'utf-8');
};

const makeGenerateCellSystemPrompt = (language: CodeLanguageType) => {
  return readFileSync(Path.join(PROMPTS_DIR, `cell-generator-${language}.txt`), 'utf-8');
};

const makeFixDiagnosticsSystemPrompt = () => {
  return readFileSync(Path.join(PROMPTS_DIR, 'fix-cell-diagnostics.txt'), 'utf-8');
};
// const makeAppBuilderSystemPrompt = () => {
//   return readFileSync(Path.join(PROMPTS_DIR, 'app-builder.txt'), 'utf-8');
// };
// const makeAppEditorSystemPrompt = () => {
//   return readFileSync(Path.join(PROMPTS_DIR, 'app-editor.txt'), 'utf-8');
// };

const makeAppEditorUserPrompt = (projectId: string, files: FileContent[], query: string) => {
  const projectXml = buildProjectXml(files, projectId);
  const userRequestXml = `<userRequest>${query}</userRequest>`;
  return `Following below are the project XML and the user request.

${projectXml}

${userRequestXml}
  `.trim();
};

const makeAppCreateUserPrompt = (projectId: string, files: FileContent[], query: string) => {
  const projectXml = buildProjectXml(files, projectId);
  const userRequestXml = `<userRequest>${query}</userRequest>`;
  return `Following below are the project XML and the user request.

${projectXml}

${userRequestXml}
  `.trim();
};

const makeGenerateCellUserPrompt = (session: SessionType, insertIdx: number, query: string) => {
  // Make sure we copy cells so we don't mutate the session
  const cellsWithPlaceholder: CellWithPlaceholderType[] = [...session.cells];

  cellsWithPlaceholder.splice(insertIdx, 0, {
    id: randomid(),
    type: 'placeholder',
    text: '==== INTRODUCE CELL HERE ====',
  });

  // Intentionally not passing in tsconfig.json here as that doesn't need to be in the prompt.
  const inlineSrcbookWithPlaceholder = encode(
    { cells: cellsWithPlaceholder, language: session.language },
    {
      inline: true,
    },
  );

  const prompt = `==== BEGIN SRCBOOK ====
${inlineSrcbookWithPlaceholder}
==== END SRCBOOK ====

==== BEGIN USER REQUEST ====
${query}
==== END USER REQUEST ====`;
  return prompt;
};

const makeFixDiagnosticsUserPrompt = (
  session: SessionType,
  cell: CodeCellType,
  diagnostics: string,
) => {
  const inlineSrcbook = encode(
    { cells: session.cells, language: session.language },
    { inline: true },
  );
  const cellSource = cell.source;
  const prompt = `==== BEGIN SRCBOOK ====
${inlineSrcbook}
==== END SRCBOOK ====

==== BEGIN CODE CELL ====
${cellSource}
==== END CODE CELL ====

==== BEGIN DIAGNOSTICS ====
${diagnostics}
==== END DIAGNOSTICS ====
`;
  return prompt;
};

const makeGenerateCellEditSystemPrompt = (language: CodeLanguageType) => {
  return readFileSync(Path.join(PROMPTS_DIR, `code-updater-${language}.txt`), 'utf-8');
};

const makeGenerateCellEditUserPrompt = (
  query: string,
  session: SessionType,
  cell: CodeCellType,
) => {
  // Intentionally not passing in tsconfig.json here as that doesn't need to be in the prompt.
  const inlineSrcbook = encode(
    { cells: session.cells, language: session.language },
    { inline: true },
  );

  const prompt = `==== BEGIN SRCBOOK ====
${inlineSrcbook}
==== END SRCBOOK ====

==== BEGIN CODE CELL ====
${cell.source}
==== END CODE CELL ====

==== BEGIN USER REQUEST ====
${query}
==== END USER REQUEST ====
`;
  return prompt;
};

type NoToolsGenerateTextResult = GenerateTextResult<{}>;
/*
 * Given a user request, which is free form text describing their intent,
 * generate a srcbook using an LLM.
 *
 * Currently, this uses openAI and the GPT-4o model, and throws if the
 * openAI API key is not set in the settings.
 * In the future, we can parameterize this with different models, to allow
 * users to use different providers like Anthropic or local ones.
 */
export async function generateSrcbook(query: string): Promise<NoToolsGenerateTextResult> {
  const model = await getModel();
  const result = await generateText({
    model,
    system: makeGenerateSrcbookSystemPrompt(),
    prompt: query,
  });

  // TODO, handle 'length' finish reason with sequencing logic.
  if (result.finishReason !== 'stop') {
    console.warn('Generated a srcbook, but finish_reason was not "stop":', result.finishReason);
  }
  return result;
}

export async function healthcheck(): Promise<string> {
  const model = await getModel();
  const result = await generateText({
    model,
    system: 'This is a test, simply respond "yes" to confirm the model is working.',
    prompt: 'Are you working?',
  });
  return result.text;
}

type GenerateCellsResult = {
  error: boolean;
  errors?: string[];
  cells?: CellType[];
};
export async function generateCells(
  query: string,
  session: SessionType,
  insertIdx: number,
): Promise<GenerateCellsResult> {
  const model = await getModel();

  const systemPrompt = makeGenerateCellSystemPrompt(session.language);
  const userPrompt = makeGenerateCellUserPrompt(session, insertIdx, query);
  const result = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
  });

  // TODO, handle 'length' finish reason with sequencing logic.
  if (result.finishReason !== 'stop') {
    console.warn('Generated a cell, but finish_reason was not "stop":', result.finishReason);
  }

  // Parse the result into cells
  // TODO: figure out logging.
  // Data is incredibly valuable for product improvements, but privacy needs to be considered.
  const decodeResult = decodeCells(result.text);

  if (decodeResult.error) {
    return { error: true, errors: decodeResult.errors };
  } else {
    return { error: false, cells: decodeResult.srcbook.cells };
  }
}

export async function generateCellEdit(query: string, session: SessionType, cell: CodeCellType) {
  const model = await getModel();

  const systemPrompt = makeGenerateCellEditSystemPrompt(session.language);
  const userPrompt = makeGenerateCellEditUserPrompt(query, session, cell);
  const result = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
  });

  return result.text;
}

export async function fixDiagnostics(
  session: SessionType,
  cell: CodeCellType,
  diagnostics: string,
): Promise<string> {
  const model = await getModel();

  const systemPrompt = makeFixDiagnosticsSystemPrompt();
  const userPrompt = makeFixDiagnosticsUserPrompt(session, cell, diagnostics);

  const result = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
  });

  return result.text;
}

/**
 * High-level function demonstrating how to:
 * 1. Build a dynamic system prompt that includes list of connected servers/tools
 * 2. Call LLM with that system prompt + userPrompt
 * 3. Parse the returned text for tool usage tags
 * 4. Call the requested MCP tools
 */
export async function generateApp(
  projectId: string,
  files: FileContent[],
  query: string,
): Promise<string> {
  await waitForMcpInit();

  const systemPrompt = await SYSTEM_PROMPT(mcpHubInstance);
  console.log('System prompt generated successfully');
  
  const model = await getModel();
  const llmResult = await generateText({
    model,
    system: systemPrompt,
    prompt: makeAppCreateUserPrompt(projectId, files, query),
  });

  // Add detailed logging of the LLM response
  console.log('Raw LLM response:', llmResult.text);

  // Strip any content before the first <plan> tag
  const planStart = llmResult.text.indexOf('<plan>');
  if (planStart === -1) {
    console.error('Raw LLM response:', llmResult.text);
    throw new Error('LLM response does not contain a <plan> tag');
  }
  const cleanedResponse = llmResult.text.slice(planStart);
  
  // Log the cleaned response before parsing
  console.log('Cleaned response for XML parsing:', cleanedResponse);

  const toolUsages = parseOutToolTags(cleanedResponse);
  
  // Log the parsed tool usages
  console.log('Parsed tool usages:', JSON.stringify(toolUsages, null, 2));

  await executeToolCalls(toolUsages);

  return cleanedResponse;
}

export async function streamEditApp(
  projectId: string,
  files: FileContent[],
  query: string,
  appId: string,
  planId: string,
) {
  await waitForMcpInit();

  const model = await getModel();
  const systemPrompt = await SYSTEM_PROMPT(mcpHubInstance);
  const userPrompt = makeAppEditorUserPrompt(projectId, files, query);

  let response = '';
  let toolUsages: Array<{
    server_name: string | undefined;
    tool_name: string | undefined;
    arguments: Record<string, unknown>;
  }> = [];

  const result = await streamText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    onChunk: (chunk) => {
      if (chunk.chunk.type === 'text-delta') {
        response += chunk.chunk.textDelta;
        
        // Try to parse tool usages as they come in
        try {
          const planStart = response.indexOf('<plan>');
          if (planStart !== -1) {
            const cleanedResponse = response.slice(planStart);
            toolUsages = parseOutToolTags(cleanedResponse);
          }
        } catch (error) {
          // Ignore parsing errors during streaming as the XML might be incomplete
          console.debug('Parsing error during streaming:', error);
        }
      }
    },
    onFinish: async () => {
      if (process.env.SRCBOOK_DISABLE_ANALYTICS !== 'true') {
        logAppGeneration({
          appId,
          planId,
          llm_request: { model, system: systemPrompt, prompt: userPrompt },
          llm_response: response,
        });
      }

      // Process tool calls after streaming is complete
      await executeToolCalls(toolUsages);
    },
  });

  return result.textStream;
} 

/**
 * Helper function to wait for MCP initialization
 */
async function waitForMcpInit() {
  while (!mcpHubInstance.isInitialized) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const toolExecutor = new ToolExecutor(mcpHubInstance, {
  github: {
    push_files: ['owner', 'branch'],
    create_repository: ['name', 'description'],
  }
});

async function executeToolCalls(
  toolUsages: Array<{
    server_name: string | undefined;
    tool_name: string | undefined;
    arguments: Record<string, unknown>;
  }>,
): Promise<any> {
  let lastToolResult: any;
  
  for (const [index, usage] of toolUsages.entries()) {
    const { server_name, tool_name, arguments: toolArgs } = usage;
    console.log(`Executing step ${index + 1}/${toolUsages.length}: ${server_name}/${tool_name}`);

    try {
      const finalArgs = {
        ...toolArgs,
        ...(index > 0 && toolArgs.requiresPreviousResult ? { previousResult: lastToolResult } : {})
      };

      const result = await toolExecutor.executeTool({
        serverName: server_name!,
        toolName: tool_name!,
        arguments: finalArgs
      });

      if (!result.success) {
        // If execution failed due to missing fields, throw a specific error
        if (result.missingFields?.length) {
          throw new Error(
            `Tool execution failed: Missing required fields for ${server_name}/${tool_name}: ${result.missingFields.join(', ')}`
          );
        }
        // Otherwise throw the general error
        throw new Error(result.error);
      }

      lastToolResult = result.data;
      console.log(`Tool result [${server_name}/${tool_name}]:`, lastToolResult);

      // Add delay between steps if needed
      if (index < toolUsages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`Failed at step ${index + 1}/${toolUsages.length}:`, error);
      throw error;
    }
  }

  return lastToolResult;
}

/**
 * Generic verification function that relies on standard tool response format
 */
async function verifyToolSuccess(
  toolResult: McpToolCallResponse,
  context: { server_name: string, tool_name: string }
): Promise<{ success: boolean; message: string }> {
  if (!toolResult) {
    return { 
      success: false, 
      message: `Tool ${context.server_name}/${context.tool_name} returned no result` 
    };
  }

  // Use the isError field from our schema
  const success = !toolResult.isError;
  
  // Extract message from content if available
  const message = toolResult.content
    .filter(item => item.type === 'text')
    .map(item => (item as { text: string }).text)
    .join('\n') || `${context.server_name}/${context.tool_name} execution completed`;

  return { success, message };
}

/**
 * Example utility function to extract <use_mcp_tool> declarations from the LLM's response text.
 * This is very flexible; you might choose a more robust XML parser if needed.
 */
function parseOutToolTags(text: string): Array<{
  server_name: string | undefined;
  tool_name: string | undefined;
  arguments: Record<string, unknown>;
}> {
  const toolPattern = /<use_mcp_tool>\s*<server_name>(.*?)<\/server_name>\s*<tool_name>(.*?)<\/tool_name>\s*<arguments>\s*([\s\S]*?)\s*<\/arguments>\s*<\/use_mcp_tool>/g;
  
  const matches = Array.from(text.matchAll(toolPattern));
  console.log('Found tool matches:', matches.length);
  
  return matches.map(match => {
    const [_, server_name, tool_name, argsText] = match;
    
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(argsText!.trim());
    } catch (err) {
      console.warn("Failed to parse arguments from <use_mcp_tool>", err);
      console.log("Raw args text:", argsText);
    }

    return {
      server_name: server_name?.trim(),
      tool_name: tool_name?.trim(),
      arguments: parsedArgs,
    };
  });
}