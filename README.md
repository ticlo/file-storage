# Ticlo file storage

`@ticlo/file-server` provides Hono routes for project and user files.
`@ticlo/file-client` provides an Axios client for those routes.

```ts
import {Hono} from 'hono';
import {routeFileStorage} from '@ticlo/file-server';

const app = new Hono();
routeFileStorage(app, {rootDir: './files'});
```

Routes default to `/file`. Provide an `authProvider` for application access
control. The default provider permits reads and writes. CORS belongs to the
hosting application, including exposing `ETag` and allowing conditional
request headers when clients run on another origin.

```ts
import {TicloFileClient} from '@ticlo/file-client';

const client = new TicloFileClient({baseURL: 'http://localhost:8047/file'});
const project = await client.createProject('example');
await client.createDirectory(`proj/${project.id}/deps/shared`);
```

Project IDs cannot contain dots. `createProject(name, templateId?, config?)`
creates an empty project when the template is omitted; supplying a template
retains template-copy behavior. Projects live in `proj/<id>` with `_proj.json`
metadata. User files live in `usr/<id>`. Empty directories are preserved and
returned by the listing API. Hidden entries and `_proj.json` are omitted from
file listings. Existing projects with dotted IDs are not listed or accessible.

Read operations (`get`, `list`, `info`, `listProj`, `readProj`, `exportProj`)
support GET. Mutating operations require POST; GET returns HTTP 405.

## Conditional writes

Downloads and uploads return a strong SHA-256 content ETag. Upload and delete
operations accept `If-Match` and `If-None-Match`; failed preconditions return
HTTP 412. For a new file, send `If-None-Match: *`. For an existing file, send
the ETag from its last read as `If-Match`:

```ts
const path = `proj/${project.id}/example.txt`;
const created = await client.uploadFileResponse(path, 'first', {}, {
  headers: {'If-None-Match': '*'},
});
await client.uploadFileResponse(path, 'second', {}, {
  headers: {'If-Match': created.headers.etag},
});
```

`uploadFileResponse` returns the full Axios response, including headers.
`uploadFile` retains its byte-count string return value. Uploads write to a
temporary sibling and atomically rename it into place. API mutations sharing
a storage root serialize within a single server process, so concurrent
conditional writers cannot both replace the same revision. Use one server
process per storage root; edits by other processes are outside this lock.
Requests without preconditions retain unconditional-write behavior.

## Development

Run `pnpm install`, `pnpm build`, `pnpm lint`, and `pnpm test:node`.
`pnpm test:browser` runs the browser HTTP tests; `pnpm dev` starts the local
development app. Build output under `packages/*/dist` is generated.

The current server source uses Hono, replacing the Fastify API in npm version
0.0.9. Consumers upgrading from that release must mount it on a Hono app and
provide the Hono peer dependency.
