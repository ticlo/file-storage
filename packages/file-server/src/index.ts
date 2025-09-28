import {promises as fs} from 'node:fs';
import path from 'node:path';
import {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {UserAuth} from './auth';
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
} from './fileOperations';
import {
  handleCreateProjectOp,
  handleDeleteProjectOp,
  handleExportProjectOp,
  handleImportProjectOp,
  handleListProjectsOp,
  handleReadProjectOp,
  handleUpdateProjectOp,
} from './projectRouteHandlers';
import {AuthProvider, FileQuerystring, FileStorageOptions} from './types';

const {mkdir} = fs;

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
  const fileContext: FileRouteContext = {
    rootDir,
    authProvider,
    logger: fastify.log,
  };

  fastify.addContentTypeParser('application/octet-stream', {parseAs: 'buffer'}, (_request, payload, done) => {
    done(null, payload);
  });

  fastify.addHook('onReady', async () => {
    await mkdir(rootDir, {recursive: true});
    await mkdir(path.join(rootDir, 'proj'), {recursive: true});
    await mkdir(path.join(rootDir, 'usr'), {recursive: true});
  });

  fastify.get(prefix + '/*', async (request, reply) => {
    const params = request.params as {'*': string};
    const rawPath = params?.['*'] ?? '';
    await handleFileDownload(request, reply, rawPath, fileContext);
  });

  fastify.get(prefix, async (request, reply) => {
    const query = request.query as FileQuerystring;
    const op = query.op;
    if (!op) {
      reply.code(400).send({message: 'Missing op parameter'});
      return;
    }
    await dispatchOperation(op, query, request, reply);
  });

  fastify.post(prefix, async (request, reply) => {
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

export {devUserAuth} from './auth';
export type {UserAuth} from './auth';
export type {FileStorageOptions, AuthProvider};
