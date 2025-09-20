import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {join} from 'path';
import {fileURLToPath} from 'url';
import {dirname} from 'path';

// Get the directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({
  logger: true,
});

// Register static file serving for www folder
// This will be registered last to give it the lowest priority
const registerStaticFiles = async () => {
  await fastify.register(fastifyStatic, {
    root: join(__dirname, '..', 'www'),
    prefix: '/', // Optional: add a prefix if needed in the future
    wildcard: true,
  });
};

// Function to start the server
const start = async () => {
  try {
    // Add other routes here before registering static files
    // This ensures static files have the lowest priority

    // Register health check endpoint as an example
    fastify.get('/health', async (request, reply) => {
      return {status: 'ok', timestamp: new Date().toISOString()};
    });

    // Register static files last (lowest priority)
    await registerStaticFiles();

    // Start the server
    await fastify.listen({
      port: 8047,
      host: '0.0.0.0',
    });

    console.log('🚀 Server running on http://localhost:8047');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Handle graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  try {
    await fastify.close();
    console.log('✅ Server closed successfully');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during shutdown:', err);
    process.exit(1);
  }
};

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
start();
