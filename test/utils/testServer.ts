import {serve, type ServerType} from '@hono/node-server';
import type {FileStorageOptions} from '@ticlo/file-server';
import {Hono} from 'hono';
import {cp, mkdtemp, readdir, rm} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface TestServer {
  app: Hono;
  server: ServerType;
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

function addCors(app: Hono): void {
  app.use('*', async (context, next) => {
    if (context.req.method === 'OPTIONS') {
      context.header('Access-Control-Allow-Origin', '*');
      context.header('Access-Control-Allow-Headers', 'content-type,x-requested-with');
      context.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      return context.body(null, 204);
    }
    await next();
    context.res.headers.set('Access-Control-Allow-Origin', '*');
    context.res.headers.set('Access-Control-Allow-Headers', 'content-type,x-requested-with');
    context.res.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function startFileServer(options: StartServerOptions = {}): Promise<TestServer> {
  const workspaceDir = await createWorkspaceFromFixtures();
  const app = new Hono();

  if (options.enableCors) {
    addCors(app);
  }

  const {devUserAuth, routeFileStorage} = await import('@ticlo/file-server');
  let server: ServerType | undefined;

  try {
    routeFileStorage(app, {
      rootDir: workspaceDir,
      authProvider: () => devUserAuth,
    } satisfies FileStorageOptions);

    const address = await new Promise<AddressInfo>((resolveListen) => {
      server = serve(
        {
          fetch: app.fetch,
          port: 0,
          hostname: '127.0.0.1',
        },
        resolveListen
      );
    });
    const baseUrl = 'http://127.0.0.1:' + address.port + '/file';

    let closed = false;
    const close = async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await closeServer(server as ServerType);
      } finally {
        await rm(workspaceDir, {recursive: true, force: true});
      }
    };

    return {
      app,
      server: server as ServerType,
      baseUrl,
      workspaceDir,
      close,
    };
  } catch (error) {
    await rm(workspaceDir, {recursive: true, force: true});
    if (server) {
      await closeServer(server).catch(() => {});
    }
    throw error;
  }
}
