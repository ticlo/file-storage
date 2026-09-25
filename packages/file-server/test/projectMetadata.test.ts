import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import AdmZip from 'adm-zip';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {TicloFileClient} from '@ticlo/file-client';
import {startFileServer, type TestServer} from '../../../test/utils/testServer';

describe('project metadata and legacy archive imports', () => {
  let server: TestServer;
  let client: TicloFileClient;
  beforeAll(async () => {
    server = await startFileServer();
    client = new TicloFileClient({baseURL: server.baseUrl});
  });
  afterAll(async () => server.close());

  it('creates, updates and exports #proj.json and hides it from file listings', async () => {
    const project = await client.createProject('metadata');
    await client.updateProject(project.id, {name: 'Updated', custom: {value: 42}});
    const file = join(server.workspaceDir, 'proj', project.id, '#proj.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({id: project.id, custom: {value: 42}});
    expect(await client.listFiles(`proj/${project.id}`)).toEqual([]);
    const response = await client.exportProject(project.id);
    const zip = new AdmZip(Buffer.from(response.data));
    expect(zip.getEntries().map((entry) => entry.entryName)).toEqual([`${project.id}/#proj.json`]);
    await client.deleteProject(project.id);
    await client.importProjects(Buffer.from(response.data));
    expect(await client.readProject(project.id)).toMatchObject({name: 'Updated', custom: {value: 42}});
  });

  it.each(['flat', 'wrapped'] as const)('converts legacy metadata in a %s archive', async (layout) => {
    const id = `legacy-${layout}`;
    const prefix = layout === 'flat' ? '' : `${id}/`;
    const zip = new AdmZip();
    zip.addFile(
      `${prefix}_proj.json`,
      Buffer.from(JSON.stringify({id, name: 'Legacy', owner: 'old', category: 'tools'}))
    );
    zip.addFile(`${prefix}flow.ticlo`, Buffer.from('{"value":42}'));
    zip.addFile(`${prefix}nested/_proj.json`, Buffer.from('ordinary file'));
    // Also replace an existing legacy project without leaving the old metadata behind.
    await client.uploadFile(`proj/${id}/_proj.json`, '{"name":"existing"}');
    const imported = await client.importProjects(zip.toBuffer());
    expect(imported).toEqual([
      expect.objectContaining({id, name: 'Legacy', owner: 'admin', category: 'tools', canRead: [], canWrite: []}),
    ]);
    const files = await readdir(join(server.workspaceDir, 'proj', id));
    expect(files).toContain('#proj.json');
    expect(files).not.toContain('_proj.json');
    expect((await client.listProjects()).map((project) => project.id)).toContain(id);
    expect(await client.readProject(id)).toMatchObject({id, name: 'Legacy'});
    expect(Buffer.from((await client.getFile(`proj/${id}/nested/_proj.json`)).data).toString()).toBe('ordinary file');
    expect(Buffer.from((await client.getFile(`proj/${id}/flow.ticlo`)).data).toString()).toBe('{"value":42}');
    const exported = new AdmZip(Buffer.from((await client.exportProject(id)).data));
    expect(exported.getEntry(`${id}/#proj.json`)).not.toBeNull();
    expect(exported.getEntry(`${id}/_proj.json`)).toBeNull();
  });

  it.each(['flat', 'wrapped'] as const)(
    'prefers current metadata over legacy metadata in a %s archive',
    async (layout) => {
      const id = `both-${layout}`;
      const prefix = layout === 'flat' ? '' : `${id}/`;
      const zip = new AdmZip();
      zip.addFile(`${prefix}#proj.json`, Buffer.from(JSON.stringify({id, name: 'Current'})));
      zip.addFile(`${prefix}_proj.json`, Buffer.from('{invalid legacy metadata'));
      expect(await client.importProjects(zip.toBuffer())).toEqual([expect.objectContaining({id, name: 'Current'})]);
      expect(await readdir(join(server.workspaceDir, 'proj', id))).toEqual(['#proj.json']);
    }
  );

  it('imports a mixed archive of current and legacy projects', async () => {
    const zip = new AdmZip();
    zip.addFile('mixed-old/_proj.json', Buffer.from('{"name":"Old"}'));
    zip.addFile('mixed-new/#proj.json', Buffer.from('{"name":"New"}'));
    const result = await client.importProjects(zip.toBuffer());
    expect(result.map((project) => project.id).sort()).toEqual(['mixed-new', 'mixed-old']);
    for (const id of ['mixed-old', 'mixed-new']) {
      expect(await readdir(join(server.workspaceDir, 'proj', id))).toEqual(['#proj.json']);
    }
  });

  it('uses the id from current metadata in a flat archive, including #root', async () => {
    const zip = new AdmZip();
    zip.addFile('#proj.json', Buffer.from('{"id":"#root","name":"Root"}'));
    expect(await client.importProjects(zip.toBuffer())).toEqual([expect.objectContaining({id: '#root'})]);
    expect((await client.readProject('#root')).name).toBe('Root');
  });
});
