import {serve, type ServerType} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import {Hono} from 'hono';
import {logger} from 'hono/logger';
import {join} from 'path';
import {routeFileStorage, devUserAuth} from '@ticlo/file-server';
import {registerSessionRoutes} from './session';

const app = new Hono();

app.use(logger());

routeFileStorage(app, {
  rootDir: join(process.cwd(), 'files'),
  authProvider: () => devUserAuth,
});

registerSessionRoutes(app);

app.get('/health', (context) => context.json({status: 'ok', timestamp: new Date().toISOString()}));
app.use('/*', serveStatic({root: './www'}));

app.notFound((context) => context.json({message: 'Not Found'}, 404));
app.onError((err, context) => {
  console.error(err);
  return context.json({message: 'Internal Server Error'}, 500);
});

const server = serve(
  {
    fetch: app.fetch,
    port: 8047,
    hostname: '0.0.0.0',
  },
  () => {
    console.log('Server running on http://localhost:8047');
  }
);

server.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

const closeServer = (serverToClose: ServerType): Promise<void> =>
  new Promise((resolve, reject) => {
    serverToClose.close((err?: Error) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

const gracefulShutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  try {
    await closeServer(server);
    console.log('Server closed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
