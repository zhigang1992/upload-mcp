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
        version: '1.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private detectContentType(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      // Images
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',

      // Documents
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

      // Text
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.csv': 'text/csv',
      '.md': 'text/markdown',

      // Archives
      '.zip': 'application/zip',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      '.7z': 'application/x-7z-compressed',
      '.rar': 'application/vnd.rar',

      // Audio
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.flac': 'audio/flac',

      // Video
      '.mp4': 'video/mp4',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.wmv': 'video/x-ms-wmv',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',

      // Code
      '.ts': 'text/typescript',
      '.tsx': 'text/typescript',
      '.py': 'text/x-python',
      '.java': 'text/x-java',
      '.c': 'text/x-c',
      '.cpp': 'text/x-c++',
      '.rs': 'text/x-rust',
      '.go': 'text/x-go',
    };

    // Return detected MIME type or default to image/jpeg if unknown
    return mimeMap[ext] || 'image/jpeg';
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
                content_type: {
                  type: 'string',
                  description: 'Optional MIME type of the file (e.g., image/png, text/plain, application/pdf). If not provided, will be auto-detected from file extension.',
                },
              },
              required: ['file_path'],
            },
          },
          {
            name: 'upload_file_content',
            description: 'Upload file content directly to S3-compatible storage and get a shareable URL. Files are automatically organized in UUID folders.',
            inputSchema: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description: 'Base64-encoded file content',
                },
                filename: {
                  type: 'string',
                  description: 'Original filename with extension',
                },
                mime_type: {
                  type: 'string',
                  description: 'MIME type of the file content (e.g., image/png, text/plain, application/pdf)',
                },
              },
              required: ['content', 'filename'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'upload_file') {
        return this.handleUploadFile(request.params.arguments as any);
      }

      if (request.params.name === 'upload_file_content') {
        return this.handleUploadFileContent(request.params.arguments as any);
      }

      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`
      );
    });
  }

  private async handleUploadFile(args: {
    file_path: string;
    content_type?: string;
  }) {
    const { file_path } = args;
    let content_type = args.content_type;

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

      // Determine content type if not provided
      if (!content_type) {
        content_type = this.detectContentType(file_path);
      }

      // Upload to S3-compatible storage using curl
      const uploadCommand = [
        'curl',
        '-X', 'PUT',
        `https://s3.reily.app/public/${remotePath}`,
        '-T', file_path,
        '-H', `Content-Type: ${content_type}`,
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
              content_type: content_type,
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

  private async handleUploadFileContent(args: {
    content: string;
    filename: string;
    mime_type?: string;
  }) {
    const { content, filename } = args;
    let mime_type = args.mime_type;

    if (!content || !filename) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'content and filename are required'
      );
    }

    try {
      // Validate base64 content
      let base64Content = content;

      // Remove data URL prefix if present (e.g., "data:image/png;base64,")
      if (base64Content.startsWith('data:')) {
        const matches = base64Content.match(/^data:(.+?);base64,(.+)$/);
        if (matches) {
          mime_type = mime_type || matches[1];
          base64Content = matches[2];
        }
      }

      // Validate that the content is valid base64
      try {
        // Try to decode a small portion to validate base64
        atob(base64Content.slice(0, 100));
      } catch (decodeError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid base64 content provided'
        );
      }

      // Generate UUID folder and preserve original filename
      const folderId = randomUUID();
      const originalFileName = basename(filename);
      const remotePath = `${folderId}/${originalFileName}`;

      // Decode base64 content and write to temporary file
      const buffer = Buffer.from(base64Content, 'base64');

      // Create temporary file for upload
      const tempFilePath = `/tmp/${folderId}_${originalFileName}`;
      await Bun.write(tempFilePath, buffer);

      // Determine MIME type if not provided
      let detectedMimeType = mime_type;
      if (!detectedMimeType) {
        // Simple MIME type detection based on file extension
        const ext = extname(filename).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.pdf': 'application/pdf',
          '.txt': 'text/plain',
          '.json': 'application/json',
          '.xml': 'application/xml',
          '.zip': 'application/zip',
          '.mp3': 'audio/mpeg',
          '.mp4': 'video/mp4',
          '.wav': 'audio/wav',
        };
        detectedMimeType = mimeMap[ext] || 'application/octet-stream';
      }

      // Upload to S3-compatible storage using curl with proper MIME type
      const uploadCommand = [
        'curl',
        '-X', 'PUT',
        `https://s3.reily.app/public/${remotePath}`,
        '-T', tempFilePath,
        '-H', `Content-Type: ${detectedMimeType}`,
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

      // Clean up temporary file
      try {
        await Bun.file(tempFilePath).delete();
      } catch (cleanupError) {
        // Log cleanup error but don't fail the operation
        console.error('Warning: Failed to clean up temporary file:', cleanupError);
      }

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
              filename: originalFileName,
              folder_id: folderId,
              mime_type: detectedMimeType,
              remote_path: remotePath,
              url: publicUrl,
              content_size: buffer.length,
              message: `File content uploaded successfully to ${publicUrl}`
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to upload file content: ${error instanceof Error ? error.message : String(error)}`
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