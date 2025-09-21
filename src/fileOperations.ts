import {createReadStream} from 'node:fs';
import {constants as fsConstants, promises as fs} from 'node:fs';
import path from 'node:path';
import type {FastifyReply, FastifyRequest} from 'fastify';
import type {UserAuth} from './auth';
import {lookUpMimeType} from './mimeTypes';
import {AuthProvider, StorageError, StoragePath, StorageScope} from './types';

const {stat, readdir, mkdir, access} = fs;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      if ((c & 1) === 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c >>>= 1;
      }
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function toPosix(partial: string[]): string {
  return partial.filter(Boolean).join('/');
}

function normalizeInput(rawPath?: string): string {
  if (!rawPath) {
    throw new StorageError('Path is required', 400);
  }
  const trimmed = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(trimmed);
  if (!normalized || normalized === '.') {
    throw new StorageError('Path is required', 400);
  }
  if (normalized.includes('..')) {
    throw new StorageError('Path cannot contain parent segments', 400);
  }
  return normalized;
}

function buildStoragePath(rawPath: string, baseDir: string): StoragePath {
  const normalized = normalizeInput(rawPath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new StorageError('Path must include scope and identifier', 400);
  }
  const [rawScope, id, ...rest] = segments;
  if (rawScope !== 'proj' && rawScope !== 'usr') {
    throw new StorageError('Unsupported storage scope', 400);
  }
  const scope = rawScope as StorageScope;
  if (!id) {
    throw new StorageError('Identifier segment is required', 400);
  }

  const projectRoot = path.resolve(baseDir, path.join(scope, id));
  const relativePath = rest.length > 0 ? path.join(...rest) : '';
  const absolute = relativePath ? path.resolve(projectRoot, relativePath) : projectRoot;

  const rootRelative = path.relative(baseDir, absolute);
  if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) {
    throw new StorageError('Resolved path escapes storage root', 400);
  }

  const posixPath = toPosix([scope, id, ...rest]);

  return {
    scope,
    id,
    relative: rest.join('/'),
    absolute,
    projectRoot,
    posixPath,
  };
}

async function resolveAuth(provider: AuthProvider, request: FastifyRequest): Promise<UserAuth> {
  const auth = await provider(request);
  if (!auth) {
    throw new StorageError('Authorization provider returned no auth context', 500);
  }
  return auth;
}

async function ensureRead(auth: UserAuth, projectId: string): Promise<void> {
  const allowed = await auth.canRead(projectId);
  if (!allowed) {
    throw new StorageError('Forbidden', 403);
  }
}

async function ensureWrite(auth: UserAuth, projectId: string): Promise<void> {
  const allowed = await auth.canWrite(projectId);
  if (!allowed) {
    throw new StorageError('Forbidden', 403);
  }
}

function buildEtag(info: {mtimeMs: number; size: number}): string {
  const modified = Math.trunc(info.mtimeMs);
  return `W/"${info.size}-${modified}"`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function coerceBodyToBuffer(body: unknown): Buffer | null {
  if (body === null || body === undefined) {
    return null;
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  if (typeof body === 'object') {
    try {
      return Buffer.from(JSON.stringify(body));
    } catch {
      return null;
    }
  }
  return null;
}

async function streamToBuffer(request: FastifyRequest): Promise<Buffer> {
  const bodyBuffer = coerceBodyToBuffer((request as FastifyRequest & {body?: unknown}).body);
  if (bodyBuffer) {
    return bodyBuffer;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request.raw) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function sendFileReply(
  reply: FastifyReply,
  storage: StoragePath,
  info: {mtime: Date; mtimeMs: number; size: number}
) {
  reply.header('ETag', buildEtag(info));
  reply.header('Last-Modified', info.mtime.toUTCString());
  reply.header('Content-Length', info.size);
  reply.type(lookUpMimeType(storage.absolute));
  return reply.send(createReadStream(storage.absolute));
}

async function listDirectory(storage: StoragePath): Promise<unknown[]> {
  try {
    const entries = await readdir(storage.absolute, {withFileTypes: true});
    const results: unknown[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '_proj.json') {
        continue;
      }
      const relativeName = storage.relative ? `${storage.relative}/${entry.name}` : entry.name;
      const posixPath = toPosix([storage.scope, storage.id, relativeName]);
      const absolute = path.join(storage.projectRoot, relativeName);
      const entryStats = await stat(absolute);
      if (entry.isDirectory()) {
        results.push({
          type: 'folder',
          path: posixPath,
          name: entry.name,
          created: Math.trunc(entryStats.birthtimeMs),
          modified: Math.trunc(entryStats.mtimeMs),
        });
      } else {
        results.push({
          type: 'file',
          path: posixPath,
          name: entry.name,
          size: entryStats.size,
          created: Math.trunc(entryStats.birthtimeMs),
          modified: Math.trunc(entryStats.mtimeMs),
        });
      }
    }
    return results;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    if (err.code === 'ENOTDIR') {
      throw new StorageError('Path is not a directory', 400);
    }
    throw error;
  }
}

async function describeFile(storage: StoragePath): Promise<unknown> {
  const info = await stat(storage.absolute);
  if (info.isDirectory()) {
    return {
      type: 'folder',
      path: storage.posixPath,
      name: path.basename(storage.absolute),
      created: Math.trunc(info.birthtimeMs),
      modified: Math.trunc(info.mtimeMs),
    };
  }
  return {
    type: 'file',
    path: storage.posixPath,
    name: path.basename(storage.absolute),
    size: info.size,
    created: Math.trunc(info.birthtimeMs),
    modified: Math.trunc(info.mtimeMs),
  };
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, {recursive: true});
}

export {
  buildEtag,
  buildStoragePath,
  crc32,
  describeFile,
  ensureParentDirectory,
  ensureRead,
  ensureWrite,
  fileExists,
  listDirectory,
  normalizeInput,
  resolveAuth,
  sendFileReply,
  streamToBuffer,
  toPosix,
};
export type {StoragePath};
