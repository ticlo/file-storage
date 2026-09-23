import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {TicloFileClient} from '@ticlo/file-client';
import {startFileServer, type TestServer} from '../utils/testServer';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

describe('project creation and conditional mutations', () => {
  let server: TestServer;
  let client: TicloFileClient;
  beforeAll(async () => {
    server = await startFileServer();
    client = new TicloFileClient({baseURL: server.baseUrl});
  });
  afterAll(async () => server.close());

  it('creates an empty project without a template and lists empty dependency folders', async () => {
    const project = await client.createProject('_root');
    expect(project.id).toBe('_root');
    expect(await client.listFiles('proj/_root')).toEqual([]);
    expect((await client.listProjects()).map((entry) => entry.id)).toContain('_root');
    await client.createDirectory('proj/_root/deps/shared');
    expect(await client.listFiles('proj/_root/deps')).toEqual([
      expect.objectContaining({name: 'shared', type: 'folder'}),
    ]);
  });

  it('rejects dots in project ids for creation and file operations', async () => {
    await expect(client.createProject('invalid.project')).rejects.toMatchObject({response: {status: 400}});
    await expect(client.uploadFile('proj/invalid.project/flow.ticlo', '{}')).rejects.toMatchObject({
      response: {status: 400},
    });
  });

  it('rejects mutations over GET', async () => {
    for (const op of [
      'upload',
      'delete',
      'mkdir',
      'rename',
      'move',
      'copy',
      'createProj',
      'deleteProj',
      'updateProj',
    ]) {
      const response = await server.app.request(`/file?op=${op}&path=proj/testProject1/file1.json`);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
    expect((await client.getFile('proj/testProject1/file1.json')).status).toBe(200);
  });

  it('returns strong revisions and rejects stale updates and deletes', async () => {
    const path = 'proj/testProject1/revision.ticlo';
    const created = await client.uploadFileResponse(path, 'first', {}, {headers: {'If-None-Match': '*'}});
    const first = created.headers.etag;
    expect(first).toMatch(/^"[a-f0-9]{64}"$/);
    expect((await client.getFile(path)).headers.etag).toBe(first);
    await expect(client.uploadFile(path, 'duplicate', {}, {headers: {'If-None-Match': '*'}})).rejects.toMatchObject({
      response: {status: 412},
    });
    const updated = await client.uploadFileResponse(path, 'other', {}, {headers: {'If-Match': first}});
    expect(updated.headers.etag).not.toBe(first);
    await expect(client.uploadFile(path, 'stale', {}, {headers: {'If-Match': first}})).rejects.toMatchObject({
      response: {status: 412},
    });
    await expect(client.deleteFile(path, {headers: {'If-Match': first}})).rejects.toMatchObject({
      response: {status: 412},
    });
    expect(Buffer.from((await client.getFile(path)).data).toString()).toBe('other');
    await client.deleteFile(path, {headers: {'If-Match': updated.headers.etag}});
    await expect(
      client.uploadFile(path, 'resurrect', {}, {headers: {'If-Match': updated.headers.etag}})
    ).rejects.toMatchObject({response: {status: 412}});
  });

  it('allows only one of two simultaneous writers using the same revision', async () => {
    const path = 'proj/testProject1/race.ticlo';
    const original = await client.uploadFileResponse(path, 'original');
    const results = await Promise.allSettled([
      client.uploadFile(path, 'a'.repeat(20000), {}, {headers: {'If-Match': original.headers.etag}}),
      client.uploadFile(path, 'b'.repeat(20000), {}, {headers: {'If-Match': original.headers.etag}}),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: {response: {status: 412}},
    });
    const content = Buffer.from((await client.getFile(path)).data).toString();
    expect(['a'.repeat(20000), 'b'.repeat(20000)]).toContain(content);
    expect((await readdir(join(server.workspaceDir, 'proj/testProject1'))).some((name) => name.endsWith('.tmp'))).toBe(
      false
    );
  });
});
