import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {TicloFileClient} from '@ticlo/file-client';
import type {TestServer} from '../utils/testServer';
import {startFileServer} from '../utils/testServer';

const textDecoder = new TextDecoder();

function arrayBufferToText(buffer: ArrayBuffer): string {
  return textDecoder.decode(buffer);
}

describe('Browser TicloFileClient e2e', () => {
  let server: TestServer;
  let client: TicloFileClient;

  beforeAll(async () => {
    server = await startFileServer();
    client = new TicloFileClient({baseURL: server.baseUrl});
  });

  afterAll(async () => {
    await server.close();
  });

  it('uploads a Blob payload and reads it back', async () => {
    const uploadPath = 'proj/testProject1/browser-upload.json';
    const payload = JSON.stringify({from: 'browser', timestamp: Date.now()});
    const blob = new Blob([payload], {type: 'application/json'});

    await client.uploadFile(uploadPath, blob, {existsBehavior: 'fail'});

    const response = await client.getFile(uploadPath);
    const content = arrayBufferToText(response.data);
    expect(content).toBe(payload);

    const info = await client.getFileInfo(uploadPath);
    expect(info.type).toBe('file');

    const listing = await client.listFiles('proj/testProject1');
    expect(listing.some((entry) => entry.path === uploadPath && entry.type === 'file')).toBe(true);
  });

  it('downloads seeded project files as ArrayBuffer', async () => {
    const response = await client.getFile('proj/testProject1/file1.json');
    const content = arrayBufferToText(response.data);
    expect(() => JSON.parse(content)).not.toThrow();
  });
});
