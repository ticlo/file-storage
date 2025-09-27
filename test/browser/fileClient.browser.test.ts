import {describe, expect, it} from 'vitest';

declare global {
  interface ImportMetaEnv {
    readonly TEST_SERVER_BASE_URL?: string;
  }
}

type StorageEntry = {
  path: string;
  name?: string;
  type?: string;
};

type ProjectMetadata = {
  id: string;
  description?: string;
  isTemplate?: boolean;
  owner?: string;
};

const baseUrl = (() => {
  const url = (import.meta.env.TEST_SERVER_BASE_URL ?? '').replace(/\/$/, '');
  if (!url) {
    throw new Error('TEST_SERVER_BASE_URL is not defined. Start the server before running browser tests.');
  }
  return url;
})();

function buildOpUrl(op: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams({op});
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'undefined' && value !== null) {
      search.append(key, value);
    }
  }
  return `${baseUrl}?${search.toString()}`;
}

async function requestOp(op: string, params: Record<string, string | undefined>, init: RequestInit = {}) {
  return fetch(buildOpUrl(op, params), {
    method: init.method ?? 'GET',
    body: init.body,
    headers: init.headers,
  });
}

async function requestOk(op: string, params: Record<string, string | undefined>, init: RequestInit = {}) {
  const response = await requestOp(op, params, init);
  if (!response.ok) {
    throw new Error(`Operation ${op} failed with status ${response.status}`);
  }
  return response;
}

async function requestJson<T>(op: string, params: Record<string, string | undefined>, init: RequestInit = {}): Promise<T> {
  const response = await requestOk(op, params, init);
  return response.json();
}

async function requestText(op: string, params: Record<string, string | undefined>, init: RequestInit = {}): Promise<string> {
  const response = await requestOk(op, params, init);
  return response.text();
}

async function requestArrayBuffer(
  op: string,
  params: Record<string, string | undefined>,
  init: RequestInit = {}
): Promise<ArrayBuffer> {
  const response = await requestOk(op, params, init);
  return response.arrayBuffer();
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Hex(bytes: Uint8Array): string {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  const result = (crc ^ -1) >>> 0;
  return result.toString(16).padStart(8, '0');
}

describe('Browser TicloFileClient', () => {
  it('performs storage operations via fetch', async () => {
    const initialList = await requestJson<StorageEntry[]>('list', {path: 'proj/testProject1'});
    expect(initialList.some((entry) => entry.path === 'proj/testProject1/file1.json')).toBe(true);

    await requestOk('mkdir', {path: 'proj/testProject1/browser-dir'}, {method: 'POST'});
    await requestOk('mkdir', {path: 'proj/testProject1/browser-dir/nested'}, {method: 'POST'});

    const uploadPath = 'proj/testProject1/browser-dir/upload.txt';
    const uploadPayload = 'browser payload via webdriverio';
    const uploadBytes = new TextEncoder().encode(uploadPayload);
    const payloadCrc = crc32Hex(uploadBytes);

    await requestText(
      'upload',
      {path: uploadPath, exists: 'fail', crc: payloadCrc},
      {
        method: 'POST',
        body: uploadBytes,
        headers: {'Content-Type': 'application/octet-stream'},
      }
    );

    const conflictResponse = await requestOp(
      'upload',
      {path: uploadPath, exists: 'fail'},
      {
        method: 'POST',
        body: uploadBytes,
        headers: {'Content-Type': 'application/octet-stream'},
      }
    );
    expect(conflictResponse.status).toBe(409);

    const downloadUrl = `${baseUrl}/${uploadPath.split('/').map(encodeURIComponent).join('/')}`;
    const downloadText = await fetch(downloadUrl).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Download failed with status ${response.status}`);
      }
      return response.text();
    });
    expect(downloadText).toBe(uploadPayload);

    await requestOk('rename', {path: uploadPath, name: 'renamed.txt'}, {method: 'POST'});
    const renamedPath = 'proj/testProject1/browser-dir/renamed.txt';

    await requestOk(
      'copy',
      {path: renamedPath, dest: 'proj/testProject1/browser-dir/renamed-copy.txt'},
      {method: 'POST'}
    );

    await requestOk(
      'move',
      {path: 'proj/testProject1/browser-dir/renamed-copy.txt', dest: 'proj/testProject1/moved/upload-copy.txt'},
      {method: 'POST'}
    );

    const movedDownloadPath = 'proj/testProject1/moved/upload-copy.txt';
    const movedDownloadUrl = `${baseUrl}/${movedDownloadPath.split('/').map(encodeURIComponent).join('/')}`;
    const movedResponse = await fetch(movedDownloadUrl);
    expect(movedResponse.ok).toBe(true);
    const movedText = await movedResponse.text();
    expect(movedText).toBe(uploadPayload);

    await requestOk('delete', {path: 'proj/testProject1/moved/upload-copy.txt'}, {method: 'POST'});
    await requestOk('delete', {path: 'proj/testProject1/moved'}, {method: 'POST'});
    await requestOk('delete', {path: renamedPath}, {method: 'POST'});
    await requestOk('delete', {path: 'proj/testProject1/browser-dir/nested'}, {method: 'POST'});
    await requestOk('delete', {path: 'proj/testProject1/browser-dir'}, {method: 'POST'});

    const finalList = await requestJson<StorageEntry[]>('list', {path: 'proj/testProject1'});
    expect(finalList.some((entry) => entry.path.startsWith('proj/testProject1/browser-dir'))).toBe(false);
    expect(finalList.some((entry) => entry.path.startsWith('proj/testProject1/moved'))).toBe(false);
  });

  it('performs project operations via fetch', async () => {
    const projects = await requestJson<ProjectMetadata[]>('listProj', {});
    expect(projects.some((project) => project.id === 'testProject1')).toBe(true);

    const metadata = await requestJson<ProjectMetadata>('readProj', {id: 'testProject1'});
    expect(metadata.id).toBe('testProject1');

    const created = await requestJson<ProjectMetadata>('createProj', {
      name: 'Browser Project',
      template: 'testProject1',
    });
    const createdId = created.id;
    expect(createdId).toBeTruthy();

    const updated = await requestJson<ProjectMetadata>(
      'updateProj',
      {id: createdId},
      {
        method: 'POST',
        body: JSON.stringify({description: 'Browser updated', tags: ['browser']}),
        headers: {'Content-Type': 'application/json'},
      }
    );
    expect(updated.description).toBe('Browser updated');

    const exportBuffer = await requestArrayBuffer('exportProj', {id: createdId});
    const exportBytes = new Uint8Array(exportBuffer);
    expect(String.fromCharCode(exportBytes[0], exportBytes[1])).toBe('PK');

    await requestOk('deleteProj', {id: createdId}, {method: 'POST'});
    const afterDelete = await requestJson<ProjectMetadata[]>('listProj', {});
    expect(afterDelete.some((project) => project.id === createdId)).toBe(false);

    const importResult = await requestJson<ProjectMetadata[]>(
      'importProj',
      {},
      {
        method: 'POST',
        body: exportBuffer,
        headers: {'Content-Type': 'application/octet-stream'},
      }
    );
    expect(importResult.some((project) => project.id === createdId)).toBe(true);

    const importedMetadata = await requestJson<ProjectMetadata>('readProj', {id: createdId});
    expect(importedMetadata.id).toBe(createdId);

    await requestOk('deleteProj', {id: createdId}, {method: 'POST'});
  });
});