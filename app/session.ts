import type {Hono} from 'hono';
import {encodeX} from './encodeX';

export function registerSessionRoutes(app: Hono): void {
  app.get('/session', (context) => {
    const salt = context.req.query('salt');
    const result: Record<string, unknown> = {
      dist: 'Ticlo',
      type: 'ticlo',
      superUser: true,
      user: 'admin',
    };
    if (salt) {
      result['productCode'] = encodeX(Math.random().toString(36).substring(2, 6) + salt + 'local-dev');
    }
    return context.json(result);
  });
}
