#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { basename, extname } from 'node:path';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// S3 configuration from environment (defaults to reily.app public bucket)
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'https://s3.reily.app';
const S3_BUCKET = process.env.S3_BUCKET || 'public';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'bhEJaGR0UGgmZtxEi2yY';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'lE1fn0FdAAhQwFLnumJt0th0Q2j684h4v8EIQdzy';
const S3_REGION = process.env.S3_REGION || 'auto';

// Multipart upload settings
const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB - use multipart for files larger than this
const PART_SIZE = 100 * 1024 * 1024; // 100MB per part

// AWS Signature V4 signing utilities
function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  return kSigning;
}

function signRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payload: Buffer | string,
  accessKey: string,
  secretKey: string,
  region: string
): Record<string, string> {
  const service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  // Create canonical URI (URL-encode each path segment)
  const canonicalUri = url.pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  // Create canonical query string (sorted by parameter name)
  const params = new URLSearchParams(url.search);
  const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalQuerystring = sortedParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  // Hash the payload
  const payloadHash = createHash('sha256')
    .update(typeof payload === 'string' ? payload : payload)
    .digest('hex');

  // Add required headers (lowercase keys for signing)
  const signedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    signedHeaders[k.toLowerCase()] = v;
  }
  signedHeaders['host'] = url.host;
  signedHeaders['x-amz-date'] = amzDate;
  signedHeaders['x-amz-content-sha256'] = payloadHash;

  // Create sorted header list
  const sortedHeaderKeys = Object.keys(signedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${signedHeaders[k].trim()}`)
    .join('\n') + '\n';
  const signedHeadersStr = sortedHeaderKeys.join(';');

  // Create canonical request
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join('\n');

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  // Calculate signature
  const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  // Create authorization header
  const authorizationHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  // Return headers with original casing for HTTP request
  const resultHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    resultHeaders[k] = v;
  }
  resultHeaders['Host'] = url.host;
  resultHeaders['X-Amz-Date'] = amzDate;
  resultHeaders['X-Amz-Content-Sha256'] = payloadHash;
  resultHeaders['Authorization'] = authorizationHeader;

  return resultHeaders;
}

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

  // Initiate multipart upload
  private async initiateMultipartUpload(remotePath: string, contentType: string): Promise<string> {
    const url = new URL(`${S3_ENDPOINT}/${S3_BUCKET}/${remotePath}?uploads`);
    const headers = signRequest(
      'POST',
      url,
      { 'Content-Type': contentType },
      '',
      S3_ACCESS_KEY,
      S3_SECRET_KEY,
      S3_REGION
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to initiate multipart upload: ${response.status} ${errorText}`);
    }

    const responseText = await response.text();
    // Parse XML response to get UploadId
    const uploadIdMatch = responseText.match(/<UploadId>(.+?)<\/UploadId>/);
    if (!uploadIdMatch) {
      throw new Error('Failed to parse UploadId from response');
    }
    return uploadIdMatch[1];
  }

  // Upload a single part
  private async uploadPart(
    remotePath: string,
    uploadId: string,
    partNumber: number,
    data: Buffer
  ): Promise<string> {
    const url = new URL(`${S3_ENDPOINT}/${S3_BUCKET}/${remotePath}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`);
    const headers = signRequest(
      'PUT',
      url,
      { 'Content-Length': String(data.length) },
      data,
      S3_ACCESS_KEY,
      S3_SECRET_KEY,
      S3_REGION
    );

    const response = await fetch(url.toString(), {
      method: 'PUT',
      headers,
      body: data,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload part ${partNumber}: ${response.status} ${errorText}`);
    }

    const etag = response.headers.get('ETag');
    if (!etag) {
      throw new Error(`No ETag returned for part ${partNumber}`);
    }
    return etag;
  }

  // Complete multipart upload
  private async completeMultipartUpload(
    remotePath: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void> {
    const url = new URL(`${S3_ENDPOINT}/${S3_BUCKET}/${remotePath}?uploadId=${encodeURIComponent(uploadId)}`);

    // Build XML body
    const partsXml = parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join('');
    const body = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

    const headers = signRequest(
      'POST',
      url,
      { 'Content-Type': 'application/xml' },
      body,
      S3_ACCESS_KEY,
      S3_SECRET_KEY,
      S3_REGION
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to complete multipart upload: ${response.status} ${errorText}`);
    }
  }

  // Abort multipart upload (cleanup on failure)
  private async abortMultipartUpload(remotePath: string, uploadId: string): Promise<void> {
    const url = new URL(`${S3_ENDPOINT}/${S3_BUCKET}/${remotePath}?uploadId=${encodeURIComponent(uploadId)}`);
    const headers = signRequest(
      'DELETE',
      url,
      {},
      '',
      S3_ACCESS_KEY,
      S3_SECRET_KEY,
      S3_REGION
    );

    await fetch(url.toString(), {
      method: 'DELETE',
      headers,
    });
  }

  // Simple PUT upload for small files
  private async simpleUpload(remotePath: string, data: Buffer, contentType: string): Promise<void> {
    const url = new URL(`${S3_ENDPOINT}/${S3_BUCKET}/${remotePath}`);
    const headers = signRequest(
      'PUT',
      url,
      { 'Content-Type': contentType, 'Content-Length': String(data.length) },
      data,
      S3_ACCESS_KEY,
      S3_SECRET_KEY,
      S3_REGION
    );

    const response = await fetch(url.toString(), {
      method: 'PUT',
      headers,
      body: data,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload file: ${response.status} ${errorText}`);
    }
  }

  // Read a chunk from file using Node.js fs
  private async readFileChunk(filePath: string, start: number, length: number): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  // Upload file with automatic multipart handling
  private async uploadToS3(filePath: string, remotePath: string, contentType: string): Promise<{ size: number; multipart: boolean }> {
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    // Check if we have credentials for multipart upload
    const hasCredentials = S3_ACCESS_KEY && S3_SECRET_KEY;

    if (fileSize <= MULTIPART_THRESHOLD || !hasCredentials) {
      // Use simple PUT for small files or when no credentials (anonymous upload)
      if (fileSize > MULTIPART_THRESHOLD && !hasCredentials) {
        console.error(`Warning: Large file (${(fileSize / 1024 / 1024).toFixed(2)} MB) but no S3 credentials - using simple PUT (may fail with size limits)`);
      }
      const data = await fs.readFile(filePath);
      await this.simpleUpload(remotePath, data, contentType);
      return { size: fileSize, multipart: false };
    }

    // Use multipart upload for large files (requires credentials)
    console.error(`Starting multipart upload for ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

    const uploadId = await this.initiateMultipartUpload(remotePath, contentType);
    const parts: Array<{ partNumber: number; etag: string }> = [];

    try {
      const totalParts = Math.ceil(fileSize / PART_SIZE);

      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        const start = (partNumber - 1) * PART_SIZE;
        const bytesToRead = Math.min(PART_SIZE, fileSize - start);

        console.error(`Uploading part ${partNumber}/${totalParts} (${(bytesToRead / 1024 / 1024).toFixed(2)} MB)`);

        // Read chunk from file
        const chunkBuffer = await this.readFileChunk(filePath, start, bytesToRead);

        const etag = await this.uploadPart(remotePath, uploadId, partNumber, chunkBuffer);
        parts.push({ partNumber, etag });
      }

      await this.completeMultipartUpload(remotePath, uploadId, parts);
      console.error(`Multipart upload completed successfully`);

      return { size: fileSize, multipart: true };
    } catch (error) {
      // Abort the multipart upload on failure
      console.error(`Multipart upload failed, aborting: ${error}`);
      await this.abortMultipartUpload(remotePath, uploadId);
      throw error;
    }
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
      // Check if file exists using Node.js fs
      try {
        await fs.access(file_path);
      } catch {
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

      // Upload to S3 (automatically uses multipart for large files)
      const { size, multipart } = await this.uploadToS3(file_path, remotePath, content_type);

      const publicUrl = `${S3_ENDPOINT}/${S3_BUCKET}/${remotePath}`;

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
              size_bytes: size,
              size_mb: (size / 1024 / 1024).toFixed(2),
              multipart_upload: multipart,
              message: `File uploaded successfully to ${publicUrl}`
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
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

      // Create temporary file for upload (use OS temp dir for cross-platform support)
      const tempFilePath = join(tmpdir(), `${folderId}_${originalFileName}`);
      await fs.writeFile(tempFilePath, buffer);

      // Determine MIME type if not provided
      let detectedMimeType = mime_type;
      if (!detectedMimeType) {
        detectedMimeType = this.detectContentType(filename);
      }

      try {
        // Upload to S3 (automatically uses multipart for large files)
        const { size, multipart } = await this.uploadToS3(tempFilePath, remotePath, detectedMimeType);

        const publicUrl = `${S3_ENDPOINT}/${S3_BUCKET}/${remotePath}`;

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
                size_bytes: size,
                size_mb: (size / 1024 / 1024).toFixed(2),
                multipart_upload: multipart,
                message: `File content uploaded successfully to ${publicUrl}`
              }, null, 2)
            }
          ]
        };
      } finally {
        // Clean up temporary file
        try {
          await fs.unlink(tempFilePath);
        } catch (cleanupError) {
          // Log cleanup error but don't fail the operation
          console.error('Warning: Failed to clean up temporary file:', cleanupError);
        }
      }
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
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