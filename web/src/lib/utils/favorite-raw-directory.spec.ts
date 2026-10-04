import { describe, expect, it, vi } from 'vitest';
import { createFavoriteRawDirectoryAccess, FavoriteRawDirectoryNeedsSelection } from './favorite-raw-directory';

describe('favorite RAW directory access', () => {
  it('remembers the first selected folder and reuses it after a page reload', async () => {
    const requestPermission = vi.fn(() => Promise.resolve('granted' as PermissionState));
    const directory = {
      kind: 'directory',
      name: 'photo_mod',
      requestPermission,
    } as unknown as FileSystemDirectoryHandle;
    let stored: FileSystemDirectoryHandle | undefined;
    const storage = {
      load: vi.fn(() => Promise.resolve(stored)),
      save: vi.fn((_userId: string, handle: FileSystemDirectoryHandle) => {
        stored = handle;
        return Promise.resolve();
      }),
      clear: vi.fn(() => {
        stored = undefined;
        return Promise.resolve();
      }),
    };
    const picker = vi.fn(() => Promise.resolve(directory));

    const firstPage = createFavoriteRawDirectoryAccess('user-1', picker, storage);
    await firstPage.warm();
    const firstSelection = await firstPage.select();
    expect(firstSelection.remembered).toBe(true);
    expect(picker).toHaveBeenCalledTimes(1);

    const nextPage = createFavoriteRawDirectoryAccess('user-1', picker, storage);
    await nextPage.warm();
    const nextSelection = await nextPage.select();
    expect(nextSelection.directory).toBe(directory);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });

    requestPermission.mockResolvedValueOnce('denied');
    await expect(nextPage.select()).rejects.toBeInstanceOf(FavoriteRawDirectoryNeedsSelection);
    expect(storage.clear).toHaveBeenCalledWith('user-1');
    await nextPage.select();
    expect(picker).toHaveBeenCalledTimes(2);
  });
});
