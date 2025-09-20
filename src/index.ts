import {createReadStream} from 'node:fs';
import type {Dirent} from 'node:fs';
import {constants as fsConstants, promises as fs} from 'node:fs';
import path from 'node:path';
import {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {randomBytes} from 'node:crypto';
import AdmZip, {IZipEntry} from 'adm-zip';
import {UserAuth} from './auth';

const {stat, readdir, mkdir, rename, rm, copyFile, writeFile, access} = fs;

type AuthProvider = (request: FastifyRequest) => UserAuth | Promise<UserAuth>;

interface FileQuerystring {
  op?: string;
  path?: string;
  dest?: string;
  name?: string;
  exists?: string;
  crc?: string;
  id?: string;
  template?: string;
}

interface FileStorageOptions {
  prefix?: string;
  rootDir?: string;
  authProvider?: AuthProvider;
}

type StorageScope = 'proj' | 'usr';

interface ProjectMetadata extends Record<string, unknown> {
  id: string;
}

const PROJECT_SCOPE = 'proj';
const PROJECT_METADATA_FILE = '_proj.json';
const KEEP_DIRECTORY_PLACEHOLDER = '.DGSERVER_KEEP_DIRECTORY';

const DEFAULT_AUTH: UserAuth = {
  getUserId: () => 'anonymous',
  canRead: () => true,
  canWrite: () => true,
};

interface StoragePath {
  scope: StorageScope;
  id: string;
  relative: string;
  absolute: string;
  projectRoot: string;
  posixPath: string;
}

class StorageError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.dg5': 'application/octet-stream',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mp4': 'video/mp4',
  '.ogg': 'application/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

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

const DEFAULT_PREFIX = '/file';
const DEFAULT_ROOT = path.resolve(process.cwd(), 'files');

function lookUpMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext in MIME_TYPES) {
    return MIME_TYPES[ext];
  }
  return 'application/octet-stream';
}

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

async function streamToBuffer(request: FastifyRequest): Promise<Buffer> {
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

function sanitizeProjectId(rawId?: string | null, field = 'Project id'): string {
  if (typeof rawId !== 'string') {
    throw new StorageError(`${field} is required`, 400);
  }
  const trimmed = rawId.trim();
  if (!trimmed) {
    throw new StorageError(`${field} is required`, 400);
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new StorageError('Invalid project id', 400);
  }
  return trimmed;
}

function projectRootPath(baseDir: string, projectId: string): string {
  return path.join(baseDir, PROJECT_SCOPE, projectId);
}

async function projectDirectoryExists(baseDir: string, projectId: string): Promise<boolean> {
  try {
    await access(projectRootPath(baseDir, projectId), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readProjectMetadata(baseDir: string, projectId: string): Promise<ProjectMetadata | null> {
  const metadataPath = path.join(projectRootPath(baseDir, projectId), PROJECT_METADATA_FILE);
  try {
    const content = await fs.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {...parsed, id: projectId};
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new StorageError(`Project ${projectId} metadata is invalid JSON`, 500);
    }
    throw error;
  }
}

async function writeProjectMetadata(
  baseDir: string,
  projectId: string,
  metadata: Record<string, unknown>
): Promise<ProjectMetadata> {
  const finalMeta: ProjectMetadata = {
    ...metadata,
    id: projectId,
  } as ProjectMetadata;
  const metadataPath = path.join(projectRootPath(baseDir, projectId), PROJECT_METADATA_FILE);
  await writeFile(metadataPath, `${JSON.stringify(finalMeta, null, 2)}\n`, 'utf8');
  return finalMeta;
}

async function listProjectsForAuth(baseDir: string, auth: UserAuth): Promise<ProjectMetadata[]> {
  const projectsDir = path.join(baseDir, PROJECT_SCOPE);
  let entries: Dirent[];
  try {
    entries = await readdir(projectsDir, {withFileTypes: true});
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const visibleProjects: ProjectMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const projectId = entry.name;
    let allowed: boolean;
    try {
      allowed = await auth.canRead(projectId);
    } catch {
      throw new StorageError(`Authorization failed for project ${projectId}`, 403);
    }
    if (!allowed) {
      continue;
    }
    const metadata = await readProjectMetadata(baseDir, projectId);
    if (metadata) {
      visibleProjects.push(metadata);
    }
  }

  visibleProjects.sort((a, b) => {
    const nameA = typeof a.name === 'string' ? (a.name as string).toLowerCase() : a.id.toLowerCase();
    const nameB = typeof b.name === 'string' ? (b.name as string).toLowerCase() : b.id.toLowerCase();
    return nameA.localeCompare(nameB);
  });

  return visibleProjects;
}

async function copyTemplateDirectory(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, {withFileTypes: true});
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, {recursive: true});
      await copyTemplateDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await ensureParentDirectory(targetPath);
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function safeGetUserId(auth: UserAuth): Promise<string> {
  try {
    const id = await auth.getUserId();
    return typeof id === 'string' && id.trim() ? id : 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function normalizeProjectIdFromName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    throw new StorageError('Project name is required', 400);
  }
  const candidate = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_');
  return sanitizeProjectId(candidate, 'Project name');
}

async function generateUniqueProjectId(baseDir: string, desiredId: string): Promise<string> {
  let candidate = desiredId;
  while (await projectDirectoryExists(baseDir, candidate)) {
    candidate = `${desiredId}_${randomBytes(3).toString('hex')}`;
  }
  return candidate;
}

async function createProjectArchiveBuffer(baseDir: string, projectId: string): Promise<Buffer> {
  const projectRoot = projectRootPath(baseDir, projectId);
  if (!(await projectDirectoryExists(baseDir, projectId))) {
    throw new StorageError('Project not found', 404);
  }

  const zip = new AdmZip();

  async function collect(relative: string): Promise<void> {
    const absolute = relative ? path.join(projectRoot, relative) : projectRoot;
    const entries = await readdir(absolute, {withFileTypes: true});
    const visible = entries.filter((entry) => {
      if (!entry.name.startsWith('.')) {
        return true;
      }
      return entry.name === PROJECT_METADATA_FILE;
    });

    if (visible.length === 0) {
      const placeholderPath = relative
        ? path.posix.join(projectId, relative.replace(/\\/g, '/'), KEEP_DIRECTORY_PLACEHOLDER)
        : path.posix.join(projectId, KEEP_DIRECTORY_PLACEHOLDER);
      zip.addFile(placeholderPath, Buffer.alloc(0));
      return;
    }

    for (const entry of visible) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await collect(childRelative);
      } else if (entry.isFile()) {
        const data = await fs.readFile(path.join(projectRoot, childRelative));
        const zipEntryName = path.posix.join(projectId, childRelative.replace(/\\/g, '/'));
        zip.addFile(zipEntryName, data);
      }
    }
  }

  await collect('');
  return zip.toBuffer();
}

interface NormalizedArchiveEntry {
  projectId: string;
  relativePath: string;
  entry: IZipEntry;
}

async function importProjectsFromArchive(
  baseDir: string,
  auth: UserAuth,
  archiveBuffer: Buffer
): Promise<ProjectMetadata[]> {
  if (archiveBuffer.length === 0) {
    throw new StorageError('Archive payload is empty', 400);
  }

  const zip = new AdmZip(archiveBuffer);
  const entries = zip.getEntries();
  if (!entries.length) {
    throw new StorageError('Archive does not contain any files', 400);
  }

  let forcedProjectId: string | null = null;
  const singleProjectMeta = entries.find((entry) => entry.entryName.replace(/\\/g, '/') === PROJECT_METADATA_FILE);
  if (singleProjectMeta) {
    const parsed = JSON.parse(singleProjectMeta.getData().toString('utf8')) as Record<string, unknown>;
    const rawId = typeof parsed.id === 'string' ? parsed.id : undefined;
    forcedProjectId = sanitizeProjectId(rawId ?? '', 'Project id');
  }

  const normalized: NormalizedArchiveEntry[] = [];
  for (const entry of entries) {
    let entryName = entry.entryName.replace(/\\/g, '/');
    entryName = entryName.replace(/^\/+/, '');
    if (!entryName) {
      continue;
    }
    const segments = entryName.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '..')) {
      throw new StorageError('Archive contains invalid paths', 400);
    }
    if (segments.some((segment) => segment.startsWith('.') && segment !== PROJECT_METADATA_FILE)) {
      continue;
    }

    if (forcedProjectId) {
      const relativePath = segments.join('/');
      if (!relativePath && entry.isDirectory) {
        continue;
      }
      normalized.push({projectId: forcedProjectId, relativePath, entry});
    } else {
      if (segments.length === 0) {
        continue;
      }
      const [projectIdSegment, ...rest] = segments;
      const projectId = sanitizeProjectId(projectIdSegment);
      const relativePath = rest.join('/');
      if (!relativePath && entry.isDirectory) {
        continue;
      }
      normalized.push({projectId, relativePath, entry});
    }
  }

  if (!normalized.length) {
    throw new StorageError('Archive does not contain any project files', 400);
  }

  const owner = await safeGetUserId(auth);
  const importedProjects = new Map<string, ProjectMetadata>();

  const grouped = normalized.reduce<Record<string, NormalizedArchiveEntry[]>>((acc, item) => {
    const list = acc[item.projectId] ?? [];
    list.push(item);
    acc[item.projectId] = list;
    return acc;
  }, {});

  for (const [projectId, items] of Object.entries(grouped)) {
    await ensureWrite(auth, projectId);
    const projectRoot = projectRootPath(baseDir, projectId);
    await mkdir(projectRoot, {recursive: true});

    for (const {entry, relativePath} of items) {
      if (!relativePath && entry.isDirectory) {
        continue;
      }
      if (relativePath.endsWith(KEEP_DIRECTORY_PLACEHOLDER)) {
        continue;
      }
      const safeRelative = relativePath.replace(/\\/g, '/');
      const destinationPath = path.join(projectRoot, safeRelative);
      if (entry.isDirectory) {
        await mkdir(destinationPath, {recursive: true});
      } else {
        await ensureParentDirectory(destinationPath);
        await writeFile(destinationPath, entry.getData());
      }
    }

    const metadata = await readProjectMetadata(baseDir, projectId);
    if (!metadata) {
      await rm(projectRoot, {recursive: true, force: true});
      throw new StorageError(`Imported project ${projectId} is missing metadata`, 400);
    }
    metadata.owner = owner;
    metadata.id = projectId;
    if (!Array.isArray(metadata.canRead)) {
      metadata.canRead = [];
    }
    if (!Array.isArray(metadata.canWrite)) {
      metadata.canWrite = [];
    }
    const saved = await writeProjectMetadata(baseDir, projectId, metadata);
    importedProjects.set(projectId, saved);
  }

  return Array.from(importedProjects.values());
}
export function routeFileStorage(fastify: FastifyInstance, options: FileStorageOptions = {}): void {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const authProvider: AuthProvider = options.authProvider ?? (() => DEFAULT_AUTH);

  fastify.addHook('onReady', async () => {
    await mkdir(rootDir, {recursive: true});
    await mkdir(path.join(rootDir, 'proj'), {recursive: true});
    await mkdir(path.join(rootDir, 'usr'), {recursive: true});
  });

  async function handleErrors<T>(reply: FastifyReply, executor: () => Promise<T>): Promise<void> {
    try {
      const payload = await executor();
      if (payload === undefined) {
        reply.code(204).send();
      } else {
        reply.send(payload);
      }
    } catch (error) {
      if (error instanceof StorageError) {
        reply.code(error.statusCode).send({message: error.message});
        return;
      }
      fastify.log.error(error);
      reply.code(500).send({message: 'Internal Server Error'});
    }
  }

  async function resolvePath(
    pathValue: string,
    request: FastifyRequest
  ): Promise<{storage: StoragePath; auth: UserAuth}> {
    const storage = buildStoragePath(pathValue, rootDir);
    const auth = await resolveAuth(authProvider, request);
    return {storage, auth};
  }

  async function handleGetRequest(request: FastifyRequest, reply: FastifyReply, rawPath: string): Promise<void> {
    await handleErrors(reply, async (): Promise<void> => {
      const {storage, auth} = await resolvePath(rawPath, request);
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
      return sendFileReply(reply, storage, info);
    });
  }

  fastify.get(`${prefix}/*`, async (request, reply) => {
    const params = request.params as {'*': string};
    const rawPath = params?.['*'] ?? '';
    await handleGetRequest(request, reply, rawPath);
  });

  fastify.get(`${prefix}`, async (request, reply) => {
    const query = request.query as FileQuerystring;
    const op = query.op;
    if (!op) {
      reply.code(400).send({message: 'Missing op parameter'});
      return;
    }
    await dispatchOperation(op, query, request, reply);
  });

  fastify.post(`${prefix}`, async (request, reply) => {
    const query = request.query as FileQuerystring;
    const op = query.op;
    if (!op) {
      reply.code(400).send({message: 'Missing op parameter'});
      return;
    }
    await dispatchOperation(op, query, request, reply);
  });

  async function dispatchOperation(
    op: string,
    query: FileQuerystring,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    switch (op) {
      case 'get': {
        if (!query.path) {
          reply.code(400).send({message: 'Path is required'});
          return;
        }
        await handleGetRequest(request as FastifyRequest<{Params: {'*': string}}>, reply, query.path);
        return;
      }
      case 'list': {
        await handleErrors(reply, async (): Promise<unknown[]> => {
          if (!query.path) {
            throw new StorageError('Path is required', 400);
          }
          const {storage, auth} = await resolvePath(query.path, request);
          await ensureRead(auth, storage.id);
          return listDirectory(storage);
        });
        return;
      }
      case 'info': {
        await handleErrors(reply, async (): Promise<unknown> => {
          if (!query.path) {
            throw new StorageError('Path is required', 400);
          }
          const {storage, auth} = await resolvePath(query.path, request);
          await ensureRead(auth, storage.id);
          let info;
          try {
            info = await describeFile(storage);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new StorageError('File not found', 404);
            }
            throw error;
          }
          return info;
        });
        return;
      }
      case 'upload': {
        await handleErrors(reply, async (): Promise<string> => {
          if (!query.path) {
            throw new StorageError('Path is required', 400);
          }
          const {storage, auth} = await resolvePath(query.path, request);
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
        });
        return;
      }
      case 'mkdir': {
        await handleErrors(reply, async (): Promise<void> => {
          if (!query.path) {
            throw new StorageError('Path is required', 400);
          }
          const {storage, auth} = await resolvePath(query.path, request);
          await ensureWrite(auth, storage.id);
          await mkdir(storage.absolute, {recursive: true});
          return undefined;
        });
        return;
      }
      case 'delete': {
        await handleErrors(reply, async (): Promise<void> => {
          if (!query.path) {
            throw new StorageError('Path is required', 400);
          }
          const {storage, auth} = await resolvePath(query.path, request);
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
        });
        return;
      }
      case 'move': {
        await handleErrors(reply, async (): Promise<void> => {
          if (!query.path || !query.dest) {
            throw new StorageError('Source and destination paths are required', 400);
          }
          const {storage: source, auth} = await resolvePath(query.path, request);
          const destination = buildStoragePath(query.dest, rootDir);
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
        });
        return;
      }
      case 'copy': {
        await handleErrors(reply, async (): Promise<void> => {
          if (!query.path || !query.dest) {
            throw new StorageError('Source and destination paths are required', 400);
          }
          const {storage: source, auth} = await resolvePath(query.path, request);
          const destination = buildStoragePath(query.dest, rootDir);
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
        });
        return;
      }
      case 'rename': {
        await handleErrors(reply, async (): Promise<void> => {
          if (!query.path || !query.name) {
            throw new StorageError('Path and name are required', 400);
          }
          const sanitized = query.name.replace(/\\/g, '/');
          if (!sanitized || sanitized.includes('/') || sanitized === '.' || sanitized === '..') {
            throw new StorageError('Invalid name parameter', 400);
          }
          const {storage, auth} = await resolvePath(query.path, request);
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
        });
        return;
      }
      case 'listProj': {
        await handleErrors(reply, async (): Promise<ProjectMetadata[]> => {
          const auth = await resolveAuth(authProvider, request);
          return listProjectsForAuth(rootDir, auth);
        });
        return;
      }
      case 'readProj': {
        await handleErrors(reply, async (): Promise<ProjectMetadata> => {
          const projectId = sanitizeProjectId(query.id);
          const auth = await resolveAuth(authProvider, request);
          await ensureRead(auth, projectId);
          const metadata = await readProjectMetadata(rootDir, projectId);
          if (!metadata) {
            throw new StorageError('Project not found', 404);
          }
          return metadata;
        });
        return;
      }
      case 'createProj': {
        await handleErrors(reply, async (): Promise<ProjectMetadata> => {
          const nameParam = query.name;
          if (!nameParam) {
            throw new StorageError('Project name is required', 400);
          }
          const templateId = sanitizeProjectId(query.template ?? '', 'Template id');
          const auth = await resolveAuth(authProvider, request);
          await ensureRead(auth, templateId);
          if (!(await projectDirectoryExists(rootDir, templateId))) {
            throw new StorageError('Template project not found', 404);
          }
          const desiredId = normalizeProjectIdFromName(nameParam);
          const projectId = await generateUniqueProjectId(rootDir, desiredId);
          await ensureWrite(auth, projectId);
          const projectDir = projectRootPath(rootDir, projectId);
          await mkdir(projectDir, {recursive: true});
          await copyTemplateDirectory(projectRootPath(rootDir, templateId), projectDir);
          const templateMeta = await readProjectMetadata(rootDir, templateId);
          const owner = await safeGetUserId(auth);
          const metadata: Record<string, unknown> = {
            owner,
            name: nameParam,
            isTemplate: false,
            canRead: [],
            canWrite: [],
          };
          if (templateMeta && typeof templateMeta.category !== 'undefined') {
            metadata.category = templateMeta.category;
          }
          return writeProjectMetadata(rootDir, projectId, metadata);
        });
        return;
      }
      case 'updateProj': {
        await handleErrors(reply, async (): Promise<ProjectMetadata> => {
          const projectId = sanitizeProjectId(query.id);
          const auth = await resolveAuth(authProvider, request);
          await ensureWrite(auth, projectId);
          if (!(await projectDirectoryExists(rootDir, projectId))) {
            throw new StorageError('Project not found', 404);
          }
          const buffer = await streamToBuffer(request);
          const body = buffer.toString('utf8').trim();
          if (!body) {
            throw new StorageError('Request body is required', 400);
          }
          let payload: unknown;
          try {
            payload = JSON.parse(body);
          } catch {
            throw new StorageError('Request body must be valid JSON', 400);
          }
          if (typeof payload !== 'object' || payload === null) {
            throw new StorageError('Project data must be a JSON object', 400);
          }
          const data = {...(payload as Record<string, unknown>)};
          delete data.id;
          return writeProjectMetadata(rootDir, projectId, data);
        });
        return;
      }
      case 'deleteProj': {
        await handleErrors(reply, async (): Promise<void> => {
          const projectId = sanitizeProjectId(query.id);
          const auth = await resolveAuth(authProvider, request);
          await ensureWrite(auth, projectId);
          const projectDir = projectRootPath(rootDir, projectId);
          try {
            await rm(projectDir, {recursive: true, force: false});
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new StorageError('Project not found', 404);
            }
            throw error;
          }
          return undefined;
        });
        return;
      }
      case 'exportProj': {
        await handleErrors(reply, async (): Promise<void> => {
          const projectId = sanitizeProjectId(query.id);
          const auth = await resolveAuth(authProvider, request);
          await ensureRead(auth, projectId);
          const archive = await createProjectArchiveBuffer(rootDir, projectId);
          reply.header('Content-Type', 'application/zip');
          reply.header('Content-Disposition', 'attachment; filename="' + projectId + '.zip"');
          reply.header('Content-Length', archive.length);
          reply.send(archive);
          return undefined;
        });
        return;
      }
      case 'importProj': {
        await handleErrors(reply, async (): Promise<ProjectMetadata[]> => {
          const auth = await resolveAuth(authProvider, request);
          const payload = await streamToBuffer(request);
          return importProjectsFromArchive(rootDir, auth, payload);
        });
        return;
      }
      default:
        reply.code(400).send({message: 'Unsupported op: ' + op});
    }
  }
}

export type {FileStorageOptions, AuthProvider};






