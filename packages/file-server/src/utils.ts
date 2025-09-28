import path from 'node:path';
import type {FastifyBaseLogger, FastifyReply} from 'fastify';
import {StorageError} from './types';

function toPosix(parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

function normalizeInput(rawPath?: string): string {
  if (!rawPath) {
    throw new StorageError('Path is required', 400);
  }
  const trimmed = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(trimmed);
  if (!normalized || normalized === '.') {
    throw new StorageError('Path is required', 400);
  }
  if (normalized.includes('..')) {
    throw new StorageError('Path cannot contain parent segments', 400);
  }
  return normalized;
}

function buildEtag(info: {mtimeMs: number; size: number}): string {
  const modified = Math.trunc(info.mtimeMs);
  return `W/"${info.size}-${modified}"`;
}

async function handleErrors<T>(
  reply: FastifyReply,
  executor: () => Promise<T>,
  logger: FastifyBaseLogger
): Promise<void> {
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
    logger.error(error);
    reply.code(500).send({message: 'Internal Server Error'});
  }
}

export {buildEtag, handleErrors, normalizeInput, toPosix};
