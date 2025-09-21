import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import {routeFileStorage} from '../src';
import {devUserAuth} from '../src/auth';
import {registerSessionRoutes} from './session';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({
  logger: true,
});

routeFileStorage(fastify, {
  rootDir: join(__dirname, '..', 'files'),
  authProvider: () => devUserAuth,
});

registerSessionRoutes(fastify);

const registerStaticFiles = async () => {
  await fastify.register(fastifyStatic, {
    root: join(__dirname, '..', 'www'),
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
