import Fastify, {type FastifyInstance} from 'fastify';
import {devUserAuth, routeFileStorage} from '@ticlo/file-server';
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

async function createWorkspaceFromFixtures(): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'ticlo-file-tests-'));
  const moduleDir = fileURLToPath(new URL('.', import.meta.url));
  const fixturesDir = resolve(moduleDir, '../../files');
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

export async function startFileServer(): Promise<TestServer> {
  const workspaceDir = await createWorkspaceFromFixtures();
  const fastify = Fastify({logger: false});

  try {
    routeFileStorage(fastify, {
      rootDir: workspaceDir,
      authProvider: () => devUserAuth,
    });

    await fastify.listen({port: 0, host: '127.0.0.1'});
    const address = fastify.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine server address');
    }
    const {port} = address;
    const baseUrl = `http://127.0.0.1:${port}/file`;

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
