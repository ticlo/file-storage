import {createReadStream} from 'node:fs';
import {constants as fsConstants, promises as fs} from 'node:fs';
import path from 'node:path';
import type {FastifyBaseLogger, FastifyReply, FastifyRequest} from 'fastify';
import type {UserAuth} from './auth';
import {lookUpMimeType} from './mimeTypes';
import {buildEtag, handleErrors, normalizeInput, toPosix} from './utils';
import {AuthProvider, FileQuerystring, StorageError, StoragePath, StorageScope} from './types';

const {stat, readdir, mkdir, access, rename, rm, copyFile, writeFile} = fs;

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

interface FileRouteContext {
  rootDir: string;
  authProvider: AuthProvider;
  logger: FastifyBaseLogger;
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

const CACHE_CONTROL_HEADER = 'max-age=0, must-revalidate';

async function sendFileReply(
  request: FastifyRequest,
  reply: FastifyReply,
  storage: StoragePath,
  info: {mtime: Date; mtimeMs: number; size: number}
) {
  const etag = buildEtag(info);
  const ifNoneMatchHeader = request.headers['if-none-match'];
  const presentedEtags = Array.isArray(ifNoneMatchHeader)
    ? ifNoneMatchHeader
    : typeof ifNoneMatchHeader === 'string'
      ? ifNoneMatchHeader.split(',')
      : [];
  const normalizedEtags = presentedEtags.map((value) => value.trim());

  if (normalizedEtags.includes('*') || normalizedEtags.includes(etag)) {
    reply.code(304);
    reply.header('Cache-Control', CACHE_CONTROL_HEADER);
    reply.header('ETag', etag);
    return reply.send();
  }

  reply.header('Cache-Control', CACHE_CONTROL_HEADER);
  reply.header('ETag', etag);
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
async function resolveStorageContext(
  rawPath: string,
  request: FastifyRequest,
  context: FileRouteContext
): Promise<{storage: StoragePath; auth: UserAuth}> {
  const storage = buildStoragePath(rawPath, context.rootDir);
  const auth = await resolveAuth(context.authProvider, request);
  return {storage, auth};
}

async function handleFileDownload(
  request: FastifyRequest,
  reply: FastifyReply,
  rawPath: string,
  context: FileRouteContext
): Promise<void> {
  await handleErrors(reply, async (): Promise<unknown> => {
    const {storage, auth} = await resolveStorageContext(rawPath, request, context);
    await ensureRead(auth, storage.id);
    let info;
    try {
      info = await stat(storage.absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('File not found', 404);
      }
      throw error;
    }
    if (info.isDirectory()) {
      throw new StorageError('Requested path is a directory', 400);
    }
    return sendFileReply(request, reply, storage, info);
  }, context.logger);
}

async function handleGetOp(
  query: FileQuerystring,
  request: FastifyRequest,
  reply: FastifyReply,
  context: FileRouteContext
): Promise<void> {
  if (!query.path) {
    reply.code(400).send({message: 'Path is required'});
    return;
  }
  await handleFileDownload(request, reply, query.path, context);
}

async function handleListOp(
  query: FileQuerystring,
  request: FastifyRequest,
  reply: FastifyReply,
  context: FileRouteContext
): Promise<void> {
  await handleErrors(reply, async (): Promise<unknown[]> => {
    if (!query.path) {
      throw new StorageError('Path is required', 400);
    }
    const {storage, auth} = await resolveStorageContext(query.path, request, context);
    await ensureRead(auth, storage.id);
    return listDirectory(storage);
  }, context.logger);
}

async function handleInfoOp(
  query: FileQuerystring,
  request: FastifyRequest,
  reply: FastifyReply,
  context: FileRouteContext
): Promise<void> {
  await handleErrors(reply, async (): Promise<unknown> => {
    if (!query.path) {
      throw new StorageError('Path is required', 400);
    }
    const {storage, auth} = await resolveStorageContext(query.path, request, context);
    await ensureRead(auth, storage.id);
    try {
      return await describeFile(storage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('File not found', 404);
      }
      throw error;
    }
  }, context.logger);
}

async function handleUploadOp(
  query: FileQuerystring,
  request: FastifyRequest,
  reply: FastifyReply,
  context: FileRouteContext
): Promise<void> {
  await handleErrors(reply, async (): Promise<string> => {
    if (!query.path) {
      throw new StorageError('Path is required', 400);
    }
    const {storage, auth} = await resolveStorageContext(query.path, request, context);
    await ensureWrite(auth, storage.id);
    await ensureParentDirectory(storage.absolute);
    const exists = await fileExists(storage.absolute);
    if (query.exists === 'fail' && exists) {
      throw new StorageError('File already exists', 409);
    }
    const buffer = await streamToBuffer(request);
    if (query.crc) {
      const computed = crc32(buffer).toString(16).padStart(8, '0');
      if (computed !== query.crc.toLowerCase()) {
        throw new StorageError('CRC mismatch', 412);
      }
    }
    await writeFile(storage.absolute, buffer);
    reply.type('text/plain; charset=utf-8');
    return Buffer.byteLength(buffer).toString();
  }, context.logger);
}

async function handleMkdirOp(
  query: FileQuerystring,
  request: FastifyRequest,
  reply: FastifyReply,
  context: FileRouteContext
): Promise<void> {
  await handleErrors(reply, async (): Promise<void> => {
    if (!query.path) {
      throw new StorageError('Path is required', 400);
    }
    const {storage, auth} = await resolveStorageContext(query.path, request, context);
    await ensureWrite(auth, storage.id);
    await mkdir(storage.absolute, {recursive: true});
    return undefined;
  }, context.logger);
}

async function handleDeleteOp(
  query: FileQuerystring,
  request: FastifyRequest,
  reply: FastifyReply,
  context: FileRouteContext
): Promise<void> {
  await handleErrors(reply, async (): Promise<void> => {
    if (!query.path) {
      throw new StorageError('Path is required', 400);
    }
    const {storage, auth} = await resolveStorageContext(query.path, request, context);
    await ensureWrite(auth, storage.id);
    try {
      await rm(storage.absolute, {recursive: true, force: false});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('File not found', 404);
      }
      throw error;
    }
    return undefined;
  }, context.logger);
}

async function handleMoveOp(
  query: FileQuerystring,
  request: FastifyRequest,
  reply: FastifyReply,
  context: FileRouteContext
): Promise<void> {
  await handleErrors(reply, async (): Promise<void> => {
    if (!query.path || !query.dest) {
      throw new StorageError('Source and destination paths are required', 400);
    }
    const {storage: source, auth} = await resolveStorageContext(query.path, request, context);
    const destination = buildStoragePath(query.dest, context.rootDir);
    if (source.scope !== destination.scope || source.id !== destination.id) {
      throw new StorageError('Move must remain within the same scope and identifier', 400);
    }
    await ensureWrite(auth, source.id);
    await ensureParentDirectory(destination.absolute);
    try {
      await rename(source.absolute, destination.absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Source file not found', 404);
      }
      throw error;
    }
    return undefined;
  }, context.logger);
}

async function handleCopyOp(
  query: FileQuerystring,
  request: FastifyRequest,
  reply: FastifyReply,
  context: FileRouteContext
): Promise<void> {
  await handleErrors(reply, async (): Promise<void> => {
    if (!query.path || !query.dest) {
      throw new StorageError('Source and destination paths are required', 400);
    }
    const {storage: source, auth} = await resolveStorageContext(query.path, request, context);
    const destination = buildStoragePath(query.dest, context.rootDir);
    if (source.scope !== destination.scope || source.id !== destination.id) {
      throw new StorageError('Copy must remain within the same scope and identifier', 400);
    }
    await ensureWrite(auth, source.id);
    await ensureParentDirectory(destination.absolute);
    try {
      const info = await stat(source.absolute);
      if (info.isDirectory()) {
        throw new StorageError('Copy does not support directories', 400);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Source file not found', 404);
      }
      throw error;
    }
    await copyFile(source.absolute, destination.absolute);
    return undefined;
  }, context.logger);
}

async function handleRenameOp(
  query: FileQuerystring,
  request: FastifyRequest,
  reply: FastifyReply,
  context: FileRouteContext
): Promise<void> {
  await handleErrors(reply, async (): Promise<void> => {
    if (!query.path || !query.name) {
      throw new StorageError('Path and name are required', 400);
    }
    const sanitized = query.name.replace(/\\/g, '/');
    if (!sanitized || sanitized.includes('/') || sanitized === '.' || sanitized === '..') {
      throw new StorageError('Invalid name parameter', 400);
    }
    const {storage, auth} = await resolveStorageContext(query.path, request, context);
    await ensureWrite(auth, storage.id);
    const destinationPath = path.join(path.dirname(storage.absolute), sanitized);
    const relativeToProject = path
      .relative(storage.projectRoot, destinationPath)
      .split(path.sep)
      .join('/');
    if (relativeToProject.startsWith('..')) {
      throw new StorageError('Rename target escapes project root', 400);
    }
    const cleanedRelative = relativeToProject === '.' ? '' : relativeToProject;
    const destination: StoragePath = {
      scope: storage.scope,
      id: storage.id,
      relative: cleanedRelative,
      absolute: destinationPath,
      projectRoot: storage.projectRoot,
      posixPath: toPosix([storage.scope, storage.id, cleanedRelative]),
    };
    await ensureParentDirectory(destination.absolute);
    try {
      await rename(storage.absolute, destination.absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('Source entry not found', 404);
      }
      throw error;
    }
    return undefined;
  }, context.logger);
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
  handleFileDownload,
  handleGetOp,
  handleListOp,
  handleInfoOp,
  handleUploadOp,
  handleMkdirOp,
  handleDeleteOp,
  handleMoveOp,
  handleCopyOp,
  handleRenameOp,
  listDirectory,
  resolveAuth,
  resolveStorageContext,
  sendFileReply,
  streamToBuffer,
};
export type {FileRouteContext, StoragePath};
