import {promises as fs} from 'node:fs';
import path from 'node:path';
import {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {UserAuth} from './auth';
import {
  buildStoragePath,
  crc32,
  describeFile,
  ensureParentDirectory,
  ensureRead,
  ensureWrite,
  fileExists,
  listDirectory,
  resolveAuth,
  sendFileReply,
  streamToBuffer,
  toPosix,
} from './fileOperations';
import {
  copyTemplateDirectory,
  createProjectArchiveBuffer,
  generateUniqueProjectId,
  importProjectsFromArchive,
  listProjectsForAuth,
  normalizeProjectIdFromName,
  projectDirectoryExists,
  projectRootPath,
  readProjectMetadata,
  sanitizeProjectId,
  safeGetUserId,
  writeProjectMetadata,
} from './projectOperations';
import {
  AuthProvider,
  FileQuerystring,
  FileStorageOptions,
  ProjectMetadata,
  StorageError,
  StoragePath,
} from './types';

const {stat, mkdir, rename, rm, copyFile, writeFile} = fs;

const DEFAULT_PREFIX = '/file';
const DEFAULT_ROOT = path.resolve(process.cwd(), 'files');

const DEFAULT_AUTH: UserAuth = {
  getUserId: () => 'anonymous',
  canRead: () => true,
  canWrite: () => true,
};

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
