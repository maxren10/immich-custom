import {
  downloadAsset,
  getAssetInfo,
  getStack,
  searchAssets,
  type AssetResponseDto,
  type SearchResponseDto,
  type StackResponseDto,
} from '@immich/sdk';

// The directory picker gate limits this feature to browsers with writable file handles.
/* eslint-disable tscompat/tscompat */

const rawExtension = /\.(arw|dng|cr2|cr3|nef|nrw|orf|raf|rw2|pef|srw)$/i;

type ExportClient = {
  search: (page: number) => Promise<SearchResponseDto>;
  asset: (id: string) => Promise<AssetResponseDto>;
  stack: (id: string) => Promise<StackResponseDto>;
};

export type FavoriteRawPlan = {
  favorites: number;
  withoutRaw: number;
  assets: AssetResponseDto[];
};

/** Resolve every favorite, including a JPG whose RAW is another stack member. */
export const collectFavoriteRaw = async (client: ExportClient): Promise<FavoriteRawPlan> => {
  const raw = new Map<string, AssetResponseDto>();
  const stacks = new Map<string, StackResponseDto>();
  let favorites = 0;
  let withoutRaw = 0;
  let page = 1;

  while (true) {
    const result = await client.search(page);
    for (const favorite of result.assets.items) {
      if (!favorite.isFavorite || favorite.isTrashed || favorite.isOffline) {
        continue;
      }

      favorites++;
      let candidate: AssetResponseDto | undefined;
      if (rawExtension.test(favorite.originalFileName)) {
        candidate = favorite;
      } else {
        const detail = favorite.stack === undefined ? await client.asset(favorite.id) : favorite;
        if (detail.stack) {
          let stack = stacks.get(detail.stack.id);
          if (!stack) {
            stack = await client.stack(detail.stack.id);
            stacks.set(detail.stack.id, stack);
          }

          if (stack.assets.some((asset) => asset.id === detail.id)) {
            candidate = stack.assets.find(
              (asset) =>
                rawExtension.test(asset.originalFileName) &&
                asset.ownerId === favorite.ownerId &&
                !asset.isTrashed &&
                !asset.isOffline,
            );
          }
        }
      }

      if (candidate) {
        raw.set(candidate.id, candidate);
      } else {
        withoutRaw++;
      }
    }

    if (!result.assets.nextPage) {
      break;
    }
    const nextPage = Number(result.assets.nextPage);
    if (!Number.isSafeInteger(nextPage) || nextPage <= page) {
      throw new Error('Invalid favorite search pagination');
    }
    page = nextPage;
  }

  return { favorites, withoutRaw, assets: [...raw.values()].sort((a, b) => a.id.localeCompare(b.id)) };
};

export const loadFavoriteRaw = () =>
  collectFavoriteRaw({
    search: (page) => searchAssets({ metadataSearchDto: { isFavorite: true, withStacked: true, page, size: 250 } }),
    asset: (id) => getAssetInfo({ id }),
    stack: (id) => getStack({ id }),
  });

const safeName = (asset: AssetResponseDto) =>
  asset.originalFileName
    .split(/[\\/]/)
    .at(-1)!
    .replaceAll(/[<>:"|?*\p{Cc}]/gu, '_');

const outputName = (asset: AssetResponseDto, duplicates: Set<string>) => {
  const name = safeName(asset);
  if (!duplicates.has(name.toLowerCase())) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  return `${name.slice(0, dot)}__${asset.id}${name.slice(dot)}`;
};

const checksumOf = async (blob: Blob) => {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return btoa(String.fromCodePoint(...new Uint8Array(digest)));
};

const manifestName = '.immich-favorite-raw-manifest.json';
type ManagedRaw = { assetId: string; name: string; sha256: string };
type ManagedManifest = { format: 'immich-favorite-raw'; version: 1; files: ManagedRaw[] };

const isNotFound = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';
const isManagedRaw = (value: unknown): value is ManagedRaw => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const file = value as Partial<ManagedRaw>;
  return (
    typeof file.assetId === 'string' &&
    file.assetId.length > 0 &&
    typeof file.name === 'string' &&
    file.name !== '.' &&
    file.name !== '..' &&
    file.name !== manifestName &&
    !/[\\/<>:"|?*\p{Cc}]/u.test(file.name) &&
    typeof file.sha256 === 'string' &&
    /^[A-Za-z0-9+/]{43}=$/.test(file.sha256)
  );
};

const readManifest = async (directory: FileSystemDirectoryHandle): Promise<ManagedManifest> => {
  let file: FileSystemFileHandle;
  try {
    file = await directory.getFileHandle(manifestName);
  } catch (error) {
    if (isNotFound(error)) {
      return { format: 'immich-favorite-raw', version: 1, files: [] };
    }
    throw error;
  }

  let value: unknown;
  try {
    const contents = await file.getFile();
    value = JSON.parse(await contents.text());
  } catch {
    throw new Error(`Cannot read ${manifestName}; no files were changed`);
  }
  const manifest = value as Partial<ManagedManifest> | null;
  if (
    !manifest ||
    manifest.format !== 'immich-favorite-raw' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every(isManagedRaw) ||
    new Set(manifest.files.map((entry) => entry.name.toLowerCase())).size !== manifest.files.length
  ) {
    throw new Error(`Invalid ${manifestName}; no files were changed`);
  }
  return manifest as ManagedManifest;
};

const writeManifest = async (directory: FileSystemDirectoryHandle, manifest: ManagedManifest) => {
  const file = await directory.getFileHandle(manifestName, { create: true });
  const writer = await file.createWritable();
  try {
    await writer.write(JSON.stringify(manifest, null, 2));
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
};

export type FavoriteRawExportResult = FavoriteRawPlan & {
  copied: number;
  existing: number;
  removed: number;
  changed: number;
};

type ExportDependencies = {
  plan: () => Promise<FavoriteRawPlan>;
  download: (id: string) => Promise<Blob>;
};

const defaultDependencies: ExportDependencies = {
  plan: loadFavoriteRaw,
  download: (id) => downloadAsset({ id, edited: false }),
};

/** The browser grants access only to a folder explicitly selected by the user. */
export const syncFavoriteRaw = async (
  directory: FileSystemDirectoryHandle,
  onProgress?: (done: number, total: number) => void,
  dependencies: ExportDependencies = defaultDependencies,
): Promise<FavoriteRawExportResult> => {
  const plan = await dependencies.plan();
  const manifest = await readManifest(directory);
  const nameCounts = new Map<string, number>();
  for (const asset of plan.assets) {
    const name = safeName(asset).toLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const duplicates = new Set([...nameCounts].filter(([, count]) => count > 1).map(([name]) => name));
  let copied = 0;
  let existing = 0;
  let removed = 0;
  let changed = 0;
  const desired = new Map(plan.assets.map((asset) => [asset.id, outputName(asset, duplicates)]));
  const desiredNames = [...desired.values()].map((name) => name.toLowerCase());
  if (new Set(desiredNames).size !== desiredNames.length) {
    throw new Error('Favorite RAW output names collide; no files were changed');
  }

  for (const asset of plan.assets) {
    const name = outputName(asset, duplicates);
    // The external file may have changed since Immich indexed it. Compare to
    // the bytes returned by the original-download endpoint, not catalog hash.
    const blob = await dependencies.download(asset.id);
    const checksum = await checksumOf(blob);
    try {
      const existingFile = await directory.getFileHandle(name);
      if ((await checksumOf(await existingFile.getFile())) !== checksum) {
        throw new Error(`Existing file differs from Immich original: ${name}`);
      }
      const managed = manifest.files.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
      if (managed && managed.assetId !== asset.id && managed.sha256 === checksum) {
        // The same RAW may be referenced by a newly favored asset. Keep the
        // verified copy and transfer its ownership to the current favorite.
        managed.assetId = asset.id;
        await writeManifest(directory, manifest);
      }
      existing++;
      onProgress?.(copied + existing, plan.assets.length);
      continue;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    const file = await directory.getFileHandle(name, { create: true });
    try {
      const writer = await file.createWritable();
      try {
        await writer.write(blob);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
      if ((await checksumOf(await file.getFile())) !== checksum) {
        throw new Error(`Copied file checksum mismatch: ${asset.originalFileName}`);
      }
    } catch (error) {
      await directory.removeEntry(name).catch(() => {});
      throw error;
    }
    manifest.files = manifest.files.filter((entry) => entry.name !== name);
    manifest.files.push({ assetId: asset.id, name, sha256: checksum });
    await writeManifest(directory, manifest);
    copied++;
    onProgress?.(copied + existing, plan.assets.length);
  }

  // Only this manifest's verified copies are eligible for deletion. A changed
  // target is preserved, even when its asset is no longer a favorite.
  for (const entry of manifest.files.toReversed()) {
    if (desired.get(entry.assetId) === entry.name) {
      continue;
    }
    let file: FileSystemFileHandle;
    try {
      file = await directory.getFileHandle(entry.name);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      manifest.files = manifest.files.filter((item) => item !== entry);
      await writeManifest(directory, manifest);
      continue;
    }
    if ((await checksumOf(await file.getFile())) !== entry.sha256) {
      changed++;
      continue;
    }
    await directory.removeEntry(entry.name);
    manifest.files = manifest.files.filter((item) => item !== entry);
    await writeManifest(directory, manifest);
    removed++;
  }

  return { ...plan, copied, existing, removed, changed };
};
