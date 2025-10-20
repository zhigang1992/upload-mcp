# @zhigang1992/uploadfile-mcp

An MCP (Model Context Protocol) server that allows you to upload local files to S3-compatible storage and get shareable URLs.

## Installation

### Global installation
```bash
npm install -g @zhigang1992/uploadfile-mcp
```

### Local installation
```bash
npm install @zhigang1992/uploadfile-mcp
```

## Usage

### Running directly with npx
```bash
npx @zhigang1992/uploadfile-mcp
```

### Adding to Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "upload-file": {
      "command": "npx",
      "args": ["@zhigang1992/uploadfile-mcp"]
    }
  }
}
```

## Available Tools

### `upload_file`

Upload a local file to S3-compatible storage and receive a shareable URL. Files are automatically organized in unique UUID folders to prevent naming conflicts.

**Parameters:**
- `file_path` (required): Local path to the file to upload

**Example usage:**
```json
{
  "file_path": "/path/to/local/file.jpg"
}
```

**Returns:**
```json
{
  "success": true,
  "file_path": "/path/to/local/file.jpg",
  "folder_id": "e4847e59-2003-443c-bd47-775fc6b6a195",
  "original_filename": "file.jpg",
  "remote_path": "e4847e59-2003-443c-bd47-775fc6b6a195/file.jpg",
  "url": "https://s3.reily.app/public/e4847e59-2003-443c-bd47-775fc6b6a195/file.jpg",
  "message": "File uploaded successfully to https://s3.reily.app/public/e4847e59-2003-443c-bd47-775fc6b6a195/file.jpg"
}
```

**Note:** Each uploaded file is placed in a unique folder (UUID-based) to prevent naming conflicts while preserving the original filename.

## Development

To install dependencies:
```bash
bun install
```

To run in development:
```bash
bun run dev
```

To build for distribution:
```bash
bun run build
```

## Configuration

This MCP server uses the S3-compatible endpoint at `https://s3.reily.app` and uploads files to the `public` bucket. The uploaded files are publicly accessible.

## License

MIT
