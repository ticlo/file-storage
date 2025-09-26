import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {TicloFileClient} from '@ticlo/file-client';
import {crc32} from '../../../packages/file-server/src/fileOperations';
import type {TestServer} from '../utils/testServer';
import {startFileServer} from '../utils/testServer';

describe('Node TicloFileClient e2e', () => {
  let server: TestServer;
  let client: TicloFileClient;

  beforeAll(async () => {
    server = await startFileServer();
    client = new TicloFileClient({baseURL: server.baseUrl});
  });

  afterAll(async () => {
    await server.close();
  });

  it('covers file operations', async () => {
    const files = await client.listFiles('proj/testProject1');
    const paths = files.map((entry) => entry.path);
    expect(paths).toContain('proj/testProject1/file1.json');

    const info = await client.getFileInfo('proj/testProject1/file1.json');
    expect(info.type).toBe('file');

    const fileResponse = await client.getFile('proj/testProject1/file1.json');
    const fileContents = Buffer.from(fileResponse.data).toString('utf8');
    expect(() => JSON.parse(fileContents)).not.toThrow();

    await client.createDirectory('proj/testProject1/new-folder');
    await client.createDirectory('proj/testProject1/new-folder/nested');
    const newFolderEntries = await client.listFiles('proj/testProject1/new-folder');
    expect(newFolderEntries.some((entry) => entry.type === 'folder' && entry.name === 'nested')).toBe(true);

    const uploadPath = 'proj/testProject1/new-folder/upload.txt';
    const payload = 'node client payload';
    const payloadCrc = crc32(Buffer.from(payload)).toString(16).padStart(8, '0');
    await client.uploadFile(uploadPath, payload, {existsBehavior: 'fail', crc: payloadCrc});

    await expect(client.uploadFile(uploadPath, payload, {existsBehavior: 'fail'})).rejects.toMatchObject({
      response: {status: 409},
    });

    await client.renameFile(uploadPath, 'upload-renamed.txt');
    const renamedPath = 'proj/testProject1/new-folder/upload-renamed.txt';
    const renamedInfo = await client.getFileInfo(renamedPath);
    expect(renamedInfo.name).toBe('upload-renamed.txt');

    await client.copyFile(renamedPath, 'proj/testProject1/new-folder/upload-copy.txt');
    const copiedInfo = await client.getFileInfo('proj/testProject1/new-folder/upload-copy.txt');
    expect(copiedInfo.name).toBe('upload-copy.txt');

    await client.moveFile('proj/testProject1/new-folder/upload-copy.txt', 'proj/testProject1/moved/upload-copy.txt');
    const movedInfo = await client.getFileInfo('proj/testProject1/moved/upload-copy.txt');
    expect(movedInfo.path).toBe('proj/testProject1/moved/upload-copy.txt');

    const movedFile = await client.getFile('proj/testProject1/moved/upload-copy.txt');
    expect(Buffer.from(movedFile.data).toString('utf8')).toBe(payload);

    await client.deleteFile('proj/testProject1/moved/upload-copy.txt');
    await expect(client.getFileInfo('proj/testProject1/moved/upload-copy.txt')).rejects.toMatchObject({
      response: {status: 404},
    });

    await client.deleteFile('proj/testProject1/moved');
    await client.deleteFile(renamedPath);
    await client.deleteFile('proj/testProject1/new-folder/nested');
    await client.deleteFile('proj/testProject1/new-folder');

    const finalListing = await client.listFiles('proj/testProject1');
    expect(finalListing.some((entry) => entry.path.startsWith('proj/testProject1/new-folder'))).toBe(false);
    expect(finalListing.some((entry) => entry.path.startsWith('proj/testProject1/moved'))).toBe(false);
  });

  it('covers project operations', async () => {
    const projects = await client.listProjects();
    expect(projects.map((project) => project.id)).toContain('testProject1');

    const projectMetadata = await client.readProject('testProject1');
    expect(projectMetadata.id).toBe('testProject1');

    const createdProject = await client.createProject('My New Project', 'testProject1');
    const createdId = createdProject.id;
    expect(createdId).toBeTruthy();
    expect(createdProject.isTemplate).toBe(false);

    const updatedMetadata = await client.updateProject(createdId, {
      description: 'Updated through e2e test',
      tags: ['e2e', 'node'],
    });
    expect(updatedMetadata.description).toBe('Updated through e2e test');

    const refreshedProjects = await client.listProjects();
    expect(refreshedProjects.map((project) => project.id)).toContain(createdId);

    const exportResponse = await client.exportProject(createdId);
    const exportBuffer = Buffer.from(exportResponse.data);
    expect(exportBuffer.subarray(0, 2).toString('utf8')).toBe('PK');

    await client.deleteProject(createdId);
    const afterDeleteProjects = await client.listProjects();
    expect(afterDeleteProjects.map((project) => project.id)).not.toContain(createdId);

    const importResult = await client.importProjects(exportBuffer);
    expect(importResult.map((project) => project.id)).toContain(createdId);

    const importedMetadata = await client.readProject(createdId);
    expect(importedMetadata.id).toBe(createdId);
    expect(importedMetadata.owner).toBe('admin');

    await client.deleteProject(createdId);
  });
});
