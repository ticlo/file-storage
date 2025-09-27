import type {TestServer} from '../utils/testServer';
import {startFileServer} from '../utils/testServer';

export default async function globalSetup() {
  const server: TestServer = await startFileServer({enableCors: true});
  process.env.TEST_SERVER_BASE_URL = server.baseUrl;

  return async () => {
    await server.close();
  };
}
