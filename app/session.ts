import {FastifyInstance, FastifyRequest} from 'fastify';
import {encodeX} from './encodeX';

interface SessionQuerystring {
  salt?: string;
}

export function registerSessionRoutes(fastify: FastifyInstance): void {
  fastify.get('/session', async (request: FastifyRequest<{Querystring: SessionQuerystring}>) => {
    const {salt} = request.query;
    const result: Record<string, unknown> = {
      dist: 'Ticlo',
      type: 'ticlo',
      superUser: true,
      user: 'admin',
    };
    if (salt) {
      result['productCode'] = encodeX(Math.random().toString(36).substring(2, 6) + salt + 'local-dev');
    }
    return result;
  });
}
