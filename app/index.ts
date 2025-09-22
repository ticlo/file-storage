import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {join} from 'path';
import {routeFileStorage, devUserAuth} from '@ticlo/file-server';
import {registerSessionRoutes} from './session';

const fastify = Fastify({
  logger: true,
});

routeFileStorage(fastify, {
  rootDir: join(process.cwd(), 'files'),
  authProvider: () => devUserAuth,
});

registerSessionRoutes(fastify);

const registerStaticFiles = async () => {
  await fastify.register(fastifyStatic, {
    root: join(process.cwd(), 'www'),
    prefix: '/',
    wildcard: true,
  });
};

const start = async () => {
  try {
    fastify.get('/health', async () => ({status: 'ok', timestamp: new Date().toISOString()}));

    await registerStaticFiles();

    await fastify.listen({
      port: 8047,
      host: '0.0.0.0',
    });

    console.log('Server running on http://localhost:8047');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

const gracefulShutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  try {
    await fastify.close();
    console.log('Server closed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

start();
