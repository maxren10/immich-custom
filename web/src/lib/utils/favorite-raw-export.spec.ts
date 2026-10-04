import type { AssetResponseDto, SearchResponseDto, StackResponseDto } from '@immich/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { collectFavoriteRaw, syncFavoriteRaw } from './favorite-raw-export';

const asset = (id: string, name: string, favorite = false, stackId?: string) =>
  ({
    id,
    originalFileName: name,
    isFavorite: favorite,
    isTrashed: false,
    isOffline: false,
    ownerId: 'owner',
    stack: stackId ? { id: stackId } : null,
  }) as AssetResponseDto;

describe('favorite RAW export plan', () => {
  it('finds a RAW beside a favorite JPG, deduplicates the stack, and reads every page', async () => {
    const raw = asset('raw-1', 'DSC0001.ARW', true, 'stack-1');
    const jpg = asset('jpg-1', 'DSC0001.JPG', true, 'stack-1');
    const jpgSearch = { ...jpg, stack: undefined } as AssetResponseDto;
    const noRaw = asset('jpg-2', 'DSC0002.JPG', true);
    const pages = [
      { assets: { items: [raw, jpgSearch], nextPage: '2' } },
      { assets: { items: [noRaw], nextPage: null } },
    ] as SearchResponseDto[];
    const stack = { id: 'stack-1', primaryAssetId: raw.id, assets: [raw, jpg] } as StackResponseDto;
    let detailReads = 0;
    let stackReads = 0;

    const plan = await collectFavoriteRaw({
      search: (page) => Promise.resolve(pages[page - 1]),
      asset: () => {
        detailReads++;
        return Promise.resolve(jpg);
      },
      stack: () => {
        stackReads++;
        return Promise.resolve(stack);
      },
    });

    expect(plan).toEqual({ favorites: 3, withoutRaw: 1, assets: [raw] });
    expect(detailReads).toBe(1);
    expect(stackReads).toBe(1);
  });

  it('copies the original once, then removes only its verified managed copy after unfavorite', async () => {
    const bytes = new TextEncoder().encode('RAW original');
    const original = new Blob([bytes]);
    const checksum = createHash('sha1').update('stale catalog bytes').digest('base64');
    const raw = { ...asset('raw-1', 'DSC0001.ARW', true), checksum } as AssetResponseDto;
    const files = new Map<string, Blob>([['unrelated.ARW', new Blob(['keep'])]]);
    const download = vi.fn(() => Promise.resolve(original));
    const directory = {
      getFileHandle: (name: string, options?: { create?: boolean }) => {
        if (!files.has(name) && !options?.create) {
          throw new DOMException('missing', 'NotFoundError');
        }
        return Promise.resolve({
          getFile: () => Promise.resolve(files.get(name)!),
          createWritable: () => {
            let staged: Blob;
            return Promise.resolve({
              write: (value: Blob | string) => {
                staged = typeof value === 'string' ? new Blob([value]) : value;
                return Promise.resolve();
              },
              close: () => {
                files.set(name, staged);
                return Promise.resolve();
              },
              abort: () => Promise.resolve(),
            });
          },
        });
      },
      removeEntry: (name: string) => {
        files.delete(name);
        return Promise.resolve();
      },
    } as unknown as FileSystemDirectoryHandle;
    let favorites = [raw];
    const dependencies = {
      plan: () => Promise.resolve({ favorites: favorites.length, withoutRaw: 0, assets: favorites }),
      download,
    };

    const first = await syncFavoriteRaw(directory, undefined, dependencies);
    const second = await syncFavoriteRaw(directory, undefined, dependencies);
    expect(first.copied).toBe(1);
    expect(second.existing).toBe(1);
    expect(download).toHaveBeenCalledTimes(2);
    expect(files.has('DSC0001.ARW')).toBe(true);

    favorites = [asset('raw-2', 'DSC0001.ARW', true)];
    const transferred = await syncFavoriteRaw(directory, undefined, dependencies);
    expect(transferred.existing).toBe(1);
    expect(transferred.removed).toBe(0);
    expect(JSON.parse(await files.get('.immich-favorite-raw-manifest.json')!.text()).files[0].assetId).toBe('raw-2');

    favorites = [];
    const unfavorite = await syncFavoriteRaw(directory, undefined, dependencies);
    expect(unfavorite.removed).toBe(1);
    expect(files.has('DSC0001.ARW')).toBe(false);
    expect(await files.get('unrelated.ARW')!.text()).toBe('keep');
    expect(JSON.parse(await files.get('.immich-favorite-raw-manifest.json')!.text()).files).toEqual([]);

    files.set('DSC0001.ARW', original);
    favorites = [raw];
    const unownedExisting = await syncFavoriteRaw(directory, undefined, dependencies);
    expect(unownedExisting.existing).toBe(1);
    favorites = [];
    const unownedUnfavorite = await syncFavoriteRaw(directory, undefined, dependencies);
    expect(unownedUnfavorite.removed).toBe(0);
    expect(files.has('DSC0001.ARW')).toBe(true);
    files.delete('DSC0001.ARW');

    favorites = [raw];
    await syncFavoriteRaw(directory, undefined, dependencies);
    files.set('DSC0001.ARW', new Blob(['different bytes']));
    favorites = [];
    const changed = await syncFavoriteRaw(directory, undefined, dependencies);
    expect(changed.changed).toBe(1);
    expect(changed.removed).toBe(0);
    expect(await files.get('DSC0001.ARW')!.text()).toBe('different bytes');
    favorites = [raw];
    await expect(syncFavoriteRaw(directory, undefined, dependencies)).rejects.toThrow('Existing file differs');
  });

  it('rejects an unsafe manifest before deleting anything', async () => {
    const manifest = new Blob([
      JSON.stringify({
        format: 'immich-favorite-raw',
        version: 1,
        files: [{ assetId: 'raw-1', name: '../source.ARW', sha256: 'a'.repeat(43) + '=' }],
      }),
    ]);
    const removeEntry = vi.fn();
    const directory = {
      getFileHandle: () => Promise.resolve({ getFile: () => Promise.resolve(manifest) }),
      removeEntry,
    } as unknown as FileSystemDirectoryHandle;
    const dependencies = {
      plan: () => Promise.resolve({ favorites: 0, withoutRaw: 0, assets: [] }),
      download: vi.fn(),
    };

    await expect(syncFavoriteRaw(directory, undefined, dependencies)).rejects.toThrow('Invalid');
    expect(removeEntry).not.toHaveBeenCalled();
  });
});
