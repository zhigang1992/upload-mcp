#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

class UploadMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: '@zhigang1992/uploadfile-mcp',
        version: '1.0.1',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'upload_file',
            description: 'Upload a local file to S3-compatible storage and get a shareable URL. Files are automatically organized in UUID folders.',
            inputSchema: {
              type: 'object',
              properties: {
                file_path: {
                  type: 'string',
                  description: 'Local path to the file to upload',
                },
              },
              required: ['file_path'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'upload_file') {
        return this.handleUploadFile(request.params.arguments as any);
      }

      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`
      );
    });
  }

  private async handleUploadFile(args: {
    file_path: string;
  }) {
    const { file_path } = args;

    if (!file_path) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'file_path is required'
      );
    }

    try {
      // Check if file exists using Bun
      const file = Bun.file(file_path);
      const exists = await file.exists();

      if (!exists) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `File not found: ${file_path}`
        );
      }
      // Generate UUID folder and preserve original filename
      const folderId = randomUUID();
      const originalFileName = basename(file_path);
      const remotePath = `${folderId}/${originalFileName}`;

      // Upload to S3-compatible storage using curl
      const uploadCommand = [
        'curl',
        '-X', 'PUT',
        `https://s3.reily.app/public/${remotePath}`,
        '-T', file_path,
        '--silent',
        '--fail'
      ];

      const uploadProcess = Bun.spawn(uploadCommand, {
        stdout: 'pipe',
        stderr: 'pipe'
      });

      const [stdout, stderr] = await Promise.all([
        uploadProcess.stdout.text(),
        uploadProcess.stderr.text()
      ]);

      const exitCode = await uploadProcess.exited;

      if (exitCode !== 0) {
        throw new Error(`Upload failed: ${stderr}`);
      }

      const publicUrl = `https://s3.reily.app/public/${remotePath}`;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              file_path: file_path,
              folder_id: folderId,
              original_filename: originalFileName,
              remote_path: remotePath,
              url: publicUrl,
              message: `File uploaded successfully to ${publicUrl}`
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to upload file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Upload MCP Server running on stdio');
  }
}

const server = new UploadMCPServer();
server.run().catch(console.error);