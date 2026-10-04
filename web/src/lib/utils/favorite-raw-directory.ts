// Directory handles can be stored in IndexedDB, but their write permission
// may need to be granted again after a browser restart.

const databaseName = 'immich-favorite-raw';
const storeName = 'directories';

type DirectoryStorage = {
  load: (userId: string) => Promise<FileSystemDirectoryHandle | undefined>;
  save: (userId: string, directory: FileSystemDirectoryHandle) => Promise<void>;
  clear: (userId: string) => Promise<void>;
};

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.addEventListener('upgradeneeded', () => request.result.createObjectStore(storeName));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });

const browserStorage: DirectoryStorage = {
  load: async (userId) => {
    const database = await openDatabase();
    try {
      return await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
        const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(userId);
        request.addEventListener('success', () => resolve(request.result as FileSystemDirectoryHandle | undefined));
        request.addEventListener('error', () => reject(request.error));
      });
    } finally {
      database.close();
    }
  },
  save: async (userId, directory) => {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(directory, userId);
        transaction.addEventListener('complete', () => resolve());
        transaction.addEventListener('error', () => reject(transaction.error));
        transaction.addEventListener('abort', () => reject(transaction.error));
      });
    } finally {
      database.close();
    }
  },
  clear: async (userId) => {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).delete(userId);
        transaction.addEventListener('complete', () => resolve());
        transaction.addEventListener('error', () => reject(transaction.error));
        transaction.addEventListener('abort', () => reject(transaction.error));
      });
    } finally {
      database.close();
    }
  },
};

export class FavoriteRawDirectoryNeedsSelection extends Error {}
export class FavoriteRawWrongDirectory extends Error {}

export const createFavoriteRawDirectoryAccess = (
  userId: string,
  picker: () => Promise<FileSystemDirectoryHandle>,
  storage: DirectoryStorage = browserStorage,
) => {
  let cached: FileSystemDirectoryHandle | undefined;
  let remembered = false;
  let revision = 0;

  return {
    forget: async () => {
      revision++;
      cached = undefined;
      remembered = false;
      await storage.clear(userId).catch(() => {});
    },
    warm: async () => {
      const currentRevision = revision;
      try {
        const restored = await storage.load(userId);
        if (
          currentRevision === revision &&
          restored?.kind === 'directory' &&
          restored.name.toLowerCase() === 'photo_mod'
        ) {
          cached = restored;
          remembered = true;
        }
      } catch {
        // A blocked or unavailable browser store should not prevent selection.
      }
    },
    select: async (forcePicker = false) => {
      if (cached && !forcePicker) {
        let permission: PermissionState = 'denied';
        try {
          permission = await (
            cached as FileSystemDirectoryHandle & {
              requestPermission: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
            }
          ).requestPermission({ mode: 'readwrite' });
        } catch {
          // A stale handle can be replaced on the next click.
        }
        if (permission === 'granted') {
          return { directory: cached, remembered };
        }
        revision++;
        cached = undefined;
        remembered = false;
        await storage.clear(userId).catch(() => {});
        throw new FavoriteRawDirectoryNeedsSelection();
      }

      // Picker invocation stays in the click's user activation path.
      const directory = await picker();
      if (directory.name.toLowerCase() !== 'photo_mod') {
        throw new FavoriteRawWrongDirectory();
      }
      revision++;
      cached = directory;
      try {
        await storage.save(userId, directory);
        remembered = true;
      } catch {
        remembered = false;
      }
      return { directory, remembered };
    },
  };
};
