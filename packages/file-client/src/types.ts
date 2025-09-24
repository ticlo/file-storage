interface FileEntryBase {
  path: string;
  name: string;
  created: number;
  modified: number;
}

interface FileEntryFile extends FileEntryBase {
  type: 'file';
  size: number;
}

interface FileEntryFolder extends FileEntryBase {
  type: 'folder';
}

type FileEntry = FileEntryFile | FileEntryFolder;

type FileInfo = FileEntry;

type ExistsBehavior = 'fail' | 'overwrite';

type ProjectMetadata = Record<string, unknown> & {
  id: string;
};

export type {ExistsBehavior, FileEntry, FileEntryFile, FileEntryFolder, FileInfo, ProjectMetadata};
