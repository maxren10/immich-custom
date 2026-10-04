<script lang="ts">
  import { AssetAction } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import AssetDeleteConfirmModal from '$lib/modals/AssetDeleteConfirmModal.svelte';
  import { showDeleteModal } from '$lib/stores/preferences.store';
  import { deleteAssets, toTimelineAssetWithStack, type OnUndoDelete } from '$lib/utils/actions';
  import type { AssetResponseDto, StackResponseDto } from '@immich/sdk';
  import { IconButton, modalManager } from '@immich/ui';
  import { mdiDeleteSweepOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction, PreAction } from './action';

  interface Props {
    asset: AssetResponseDto;
    stack: StackResponseDto;
    onAction: OnAction;
    preAction: PreAction;
    onUndoDelete?: OnUndoDelete;
  }

  let { asset, stack, onAction, preAction, onUndoDelete = undefined }: Props = $props();

  const force = $derived(asset.isTrashed || !featureFlagsManager.value.trash);
  const label = $derived(`${force ? $t('permanently_delete') : $t('delete')} ${$t('stack')}`);

  const deleteStackAssets = async () => {
    const assets = stack.assets.map((asset) => toTimelineAssetWithStack(asset, stack));

    if (force && $showDeleteModal) {
      const confirmed = await modalManager.show(AssetDeleteConfirmModal, { size: assets.length });
      if (!confirmed) {
        return;
      }
    }

    const action = force ? AssetAction.DELETE : AssetAction.TRASH;
    const primaryAsset = stack.assets.find(({ id }) => id === stack.primaryAssetId) ?? asset;
    const timelineAsset = toTimelineAssetWithStack(primaryAsset, stack);
    preAction({ type: action, asset: timelineAsset });
    await deleteAssets(
      force,
      () => onAction({ type: action, asset: timelineAsset }),
      assets,
      force ? undefined : onUndoDelete,
      (updatedStack) => onAction({ type: AssetAction.SET_STACK_PRIMARY_ASSET, stack: updatedStack }),
    );
  };
</script>

<IconButton
  color="secondary"
  shape="round"
  variant="ghost"
  icon={mdiDeleteSweepOutline}
  aria-label={label}
  onclick={deleteStackAssets}
/>
