import Fastify, {type FastifyInstance} from 'fastify';
import type {FileStorageOptions} from '@ticlo/file-server';
import {cp, mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AddressInfo} from 'node:net';

export interface TestServer {
  fastify: FastifyInstance;
  baseUrl: string;
  workspaceDir: string;
  close(): Promise<void>;
}

export interface StartServerOptions {
  enableCors?: boolean;
}

async function createWorkspaceFromFixtures(): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'ticlo-file-tests-'));
  const moduleDir = fileURLToPath(new URL('.', import.meta.url));
  const fixturesDir = resolve(moduleDir, '../files');
  const entries = await readdir(fixturesDir);
  await Promise.all(
    entries.map(async (entry) => {
      const source = resolve(fixturesDir, entry);
      const destination = resolve(workspaceDir, entry);
      await cp(source, destination, {recursive: true});
    })
  );
  return workspaceDir;
}

export async function startFileServer(options: StartServerOptions = {}): Promise<TestServer> {
  const workspaceDir = await createWorkspaceFromFixtures();
  const fastify = Fastify({logger: false});

  if (options.enableCors) {
    fastify.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Headers', 'content-type,x-requested-with');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      return payload;
    });

    fastify.options('*', async (_request, reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Headers', 'content-type,x-requested-with');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      reply.status(204).send();
    });
  }

  const {devUserAuth, routeFileStorage} = await import('@ticlo/file-server');

  try {
    routeFileStorage(
      fastify,
      {
        rootDir: workspaceDir,
        authProvider: () => devUserAuth,
      } satisfies FileStorageOptions
    );

    await fastify.listen({port: 0, host: '127.0.0.1'});
    const address = fastify.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine server address');
    }
    const {port} = address as AddressInfo;
    const baseUrl = "http://127.0.0.1:" + port + "/file";

    let closed = false;
    const close = async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await fastify.close();
      } finally {
        await rm(workspaceDir, {recursive: true, force: true});
      }
    };

    return {
      fastify,
      baseUrl,
      workspaceDir,
      close,
    };
  } catch (error) {
    await rm(workspaceDir, {recursive: true, force: true});
    await fastify.close().catch(() => {});
    throw error;
  }
}