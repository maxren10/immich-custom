import {
  AssetVisibility,
  deleteAssets as deleteBulk,
  getStack,
  restoreAssets,
  updateStack,
  type AssetResponseDto,
  type StackResponseDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import type { StackResponse } from '$lib/utils/asset-utils';
import { toTimelineAsset } from '$lib/utils/timeline-util';
import { handleError } from './handle-error';

export type OnDelete = (assetIds: string[]) => void;
export type OnUndoDelete = (assets: TimelineAsset[]) => void;
export type OnRestore = (ids: string[]) => void;
export type OnLink = (assets: { still: TimelineAsset; motion: TimelineAsset }) => void;
export type OnUnlink = (assets: { still: TimelineAsset; motion: TimelineAsset }) => void;
export type OnAddToAlbum = (ids: string[], albumId: string) => void;
export type OnArchive = (ids: string[], visibility: AssetVisibility) => void;
export type OnFavorite = (ids: string[], favorite: boolean) => void;
export type OnStack = (result: StackResponse) => void;
export type OnUnstack = (assets: TimelineAsset[]) => void;
export type OnSetVisibility = (ids: string[]) => void;

export type OnStackPrimaryChange = (stack: StackResponseDto) => void;

export const toTimelineAssetWithStack = (asset: AssetResponseDto, stack?: StackResponseDto | null): TimelineAsset => {
  const timelineAsset = toTimelineAsset(asset);
  if (!stack) {
    return timelineAsset;
  }

  return {
    ...timelineAsset,
    stack: {
      id: stack.id,
      primaryAssetId: stack.primaryAssetId,
      assetCount: stack.assets.length,
    },
  };
};

export const deleteAssetsStackAware = async (
  force: boolean,
  assets: TimelineAsset[],
  onStackPrimaryChange?: OnStackPrimaryChange,
) => {
  const ids = [...new Set(assets.map(({ id }) => id))];
  const idsToDelete = new Set(ids);
  const primaryStackIds = [
    ...new Set(assets.filter(({ id, stack }) => stack?.primaryAssetId === id).map(({ stack }) => stack!.id)),
  ];
  const primaryIdsToDeleteLast = new Set<string>();

  for (const stackId of primaryStackIds) {
    const stack = await getStack({ id: stackId });
    const survivingAsset = stack.assets.find(({ id }) => !idsToDelete.has(id));

    if (survivingAsset) {
      const updatedStack = await updateStack({
        id: stack.id,
        stackUpdateDto: { primaryAssetId: survivingAsset.id },
      });
      onStackPrimaryChange?.(updatedStack);
    } else if (idsToDelete.has(stack.primaryAssetId)) {
      primaryIdsToDeleteLast.add(stack.primaryAssetId);
    }
  }

  const firstIds = ids.filter((id) => !primaryIdsToDeleteLast.has(id));
  const lastIds = ids.filter((id) => primaryIdsToDeleteLast.has(id));

  if (firstIds.length > 0) {
    await deleteBulk({ assetBulkDeleteDto: { ids: firstIds, force } });
  }
  if (lastIds.length > 0) {
    await deleteBulk({ assetBulkDeleteDto: { ids: lastIds, force } });
  }

  return ids;
};

export const deleteAssets = async (
  force: boolean,
  onAssetDelete: OnDelete,
  assets: TimelineAsset[],
  onUndoDelete: OnUndoDelete | undefined = undefined,
  onStackPrimaryChange: OnStackPrimaryChange | undefined = undefined,
) => {
  const $t = get(t);
  try {
    const ids = await deleteAssetsStackAware(force, assets, onStackPrimaryChange);
    onAssetDelete(ids);

    toastManager.primary(
      {
        description: force
          ? $t('assets_permanently_deleted_count', { values: { count: ids.length } })
          : $t('assets_trashed_count', { values: { count: ids.length } }),
        button:
          onUndoDelete && !force
            ? { label: $t('undo'), color: 'secondary', onclick: () => undoDeleteAssets(onUndoDelete, assets) }
            : undefined,
      },
      { timeout: 5000 },
    );
  } catch (error) {
    handleError(error, $t('errors.unable_to_delete_assets'));
  }
};

const undoDeleteAssets = async (onUndoDelete: OnUndoDelete, assets: TimelineAsset[]) => {
  const $t = get(t);
  try {
    const ids = assets.map((a) => a.id);
    await restoreAssets({ bulkIdsDto: { ids } });
    onUndoDelete?.(assets);
  } catch (error) {
    handleError(error, $t('errors.unable_to_restore_assets'));
  }
};

/**
 * Update the asset stack state in the asset store based on the provided stack response.
 * This function updates the stack information so that the icon is shown for the primary asset
 * and removes any assets from the timeline that are marked for deletion.
 *
 * @param {TimelineManager} timelineManager - The timeline manager to update.
 * @param {StackResponse} stackResponse - The stack response containing the stack and assets to delete.
 */
export function updateStackedAssetInTimeline(timelineManager: TimelineManager, { stack, toDeleteIds }: StackResponse) {
  if (stack == undefined) {
    return;
  }

  timelineManager.update(
    [stack.primaryAssetId],
    (asset) =>
      (asset.stack = {
        id: stack.id,
        primaryAssetId: stack.primaryAssetId,
        assetCount: stack.assets.length,
      }),
  );

  timelineManager.removeAssets(toDeleteIds);
}

/**
 * Update the timeline manager to reflect the unstacked state of assets.
 * This function updates the stack property of each asset to undefined, effectively unstacking them.
 * It also adds the unstacked assets back to the timeline manager.
 *
 * @param timelineManager - The timeline manager to update.
 * @param assets - The array of asset response DTOs to update in the timeline manager.
 */
export function updateUnstackedAssetInTimeline(timelineManager: TimelineManager, assets: TimelineAsset[]) {
  timelineManager.update(
    assets.map((asset) => asset.id),
    (asset) => {
      asset.stack = null;
      return { remove: false };
    },
  );

  timelineManager.upsertAssets(assets);
}
