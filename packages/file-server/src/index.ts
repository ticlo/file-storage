import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {Hono} from 'hono';
import {UserAuth} from './auth.js';
import {
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
  type FileRouteContext,
} from './fileOperations.js';
import {
  handleCreateProjectOp,
  handleDeleteProjectOp,
  handleExportProjectOp,
  handleImportProjectOp,
  handleListProjectsOp,
  handleReadProjectOp,
  handleUpdateProjectOp,
} from './projectRouteHandlers.js';
import {HonoReply, withStorageLock} from './utils.js';
import {AuthProvider, FileQuerystring, FileStorageOptions, StorageContext} from './types.js';

const {mkdir} = fs;

const DEFAULT_PREFIX = '/file';
const DEFAULT_ROOT = path.resolve(process.cwd(), 'files');

const DEFAULT_AUTH: UserAuth = {
  getUserId: () => 'anonymous',
  canRead: () => true,
  canWrite: () => true,
};

export function routeFileStorage(app: Hono, options: FileStorageOptions = {}): void {
  const prefix = (options.prefix ?? DEFAULT_PREFIX).replace(/\/$/, '') || '/';
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const authProvider: AuthProvider = options.authProvider ?? (() => DEFAULT_AUTH);
  const fileContext: FileRouteContext = {
    rootDir,
    authProvider,
    logger: console,
  };
  const ready = initStorageRoot(rootDir);

  app.get(prefix, async (request) => {
    await ready;
    const reply = new HonoReply();
    const query = request.req.query() as FileQuerystring;
    const op = query.op;
    if (!op) {
      reply.code(400).send({message: 'Missing op parameter'});
      return reply.toResponse();
    }
    if (!['get', 'list', 'info', 'listProj', 'readProj', 'exportProj'].includes(op)) {
      return reply.code(405).header('Allow', 'POST').send({message: 'Operation requires POST'});
    }
    await dispatchOperation(op, query, request, reply);
    return reply.toResponse();
  });

  app.post(prefix, async (request) => {
    await ready;
    const reply = new HonoReply();
    const query = request.req.query() as FileQuerystring;
    const op = query.op;
    if (!op) {
      reply.code(400).send({message: 'Missing op parameter'});
      return reply.toResponse();
    }
    await withStorageLock(rootDir, () => dispatchOperation(op, query, request, reply));
    return reply.toResponse();
  });

  app.get(prefix + '/*', async (request) => {
    await ready;
    const reply = new HonoReply();
    const rawPath = getDownloadPath(request, prefix);
    await handleFileDownload(request, reply, rawPath, fileContext);
    return reply.toResponse();
  });

  async function dispatchOperation(
    op: string,
    query: FileQuerystring,
    request: StorageContext,
    reply: HonoReply
  ): Promise<void> {
    switch (op) {
      case 'get': {
        await handleGetOp(query, request, reply, fileContext);
        return;
      }
      case 'list': {
        await handleListOp(query, request, reply, fileContext);
        return;
      }
      case 'info': {
        await handleInfoOp(query, request, reply, fileContext);
        return;
      }
      case 'upload': {
        await handleUploadOp(query, request, reply, fileContext);
        return;
      }
      case 'mkdir': {
        await handleMkdirOp(query, request, reply, fileContext);
        return;
      }
      case 'delete': {
        await handleDeleteOp(query, request, reply, fileContext);
        return;
      }
      case 'move': {
        await handleMoveOp(query, request, reply, fileContext);
        return;
      }
      case 'copy': {
        await handleCopyOp(query, request, reply, fileContext);
        return;
      }
      case 'rename': {
        await handleRenameOp(query, request, reply, fileContext);
        return;
      }
      case 'listProj': {
        await handleListProjectsOp(query, request, reply, fileContext);
        return;
      }
      case 'readProj': {
        await handleReadProjectOp(query, request, reply, fileContext);
        return;
      }
      case 'createProj': {
        await handleCreateProjectOp(query, request, reply, fileContext);
        return;
      }
      case 'updateProj': {
        await handleUpdateProjectOp(query, request, reply, fileContext);
        return;
      }
      case 'deleteProj': {
        await handleDeleteProjectOp(query, request, reply, fileContext);
        return;
      }
      case 'exportProj': {
        await handleExportProjectOp(query, request, reply, fileContext);
        return;
      }
      case 'importProj': {
        await handleImportProjectOp(query, request, reply, fileContext);
        return;
      }
      default:
        reply.code(400).send({message: 'Unsupported op: ' + op});
    }
  }
}

async function initStorageRoot(rootDir: string): Promise<void> {
  await mkdir(rootDir, {recursive: true});
  await mkdir(path.join(rootDir, 'proj'), {recursive: true});
  await mkdir(path.join(rootDir, 'usr'), {recursive: true});
}

function getDownloadPath(request: StorageContext, prefix: string): string {
  const pathPrefix = prefix + '/';
  const rawPath = request.req.path.startsWith(pathPrefix) ? request.req.path.slice(pathPrefix.length) : '';
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

export {devUserAuth} from './auth.js';
export type {UserAuth} from './auth.js';
export type {FileStorageOptions, AuthProvider};
