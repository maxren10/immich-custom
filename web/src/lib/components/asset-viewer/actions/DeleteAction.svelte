<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import { AssetAction } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import AssetDeleteConfirmModal from '$lib/modals/AssetDeleteConfirmModal.svelte';
  import { showDeleteModal } from '$lib/stores/preferences.store';
  import { deleteAssets as deleteAssetsUtil, toTimelineAssetWithStack, type OnUndoDelete } from '$lib/utils/actions';
  import type { AssetResponseDto, StackResponseDto } from '@immich/sdk';
  import { IconButton, modalManager } from '@immich/ui';
  import { mdiDeleteForeverOutline, mdiDeleteOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction, PreAction } from './action';

  interface Props {
    asset: AssetResponseDto;
    stack?: StackResponseDto | null;
    onAction: OnAction;
    preAction: PreAction;
    onUndoDelete?: OnUndoDelete;
  }

  let { asset, stack = null, onAction, preAction, onUndoDelete = undefined }: Props = $props();

  const forceDefault = $derived(asset.isTrashed || !featureFlagsManager.value.trash);

  const trashOrDelete = async (forceRequest?: boolean) => {
    const timelineAsset = toTimelineAssetWithStack(asset, stack);
    const force = forceDefault || forceRequest === true;

    if (force && $showDeleteModal) {
      const confirmed = await modalManager.show(AssetDeleteConfirmModal, { size: 1 });
      if (!confirmed) {
        return;
      }
    }

    const action = force ? AssetAction.DELETE : AssetAction.TRASH;
    preAction({ type: action, asset: timelineAsset });
    await deleteAssetsUtil(
      force,
      () => onAction({ type: action, asset: timelineAsset }),
      [timelineAsset],
      force ? undefined : onUndoDelete,
      (updatedStack) => onAction({ type: AssetAction.SET_STACK_PRIMARY_ASSET, stack: updatedStack }),
    );
  };
</script>

<svelte:document
  use:shortcuts={[
    { shortcut: { key: 'Delete' }, onShortcut: () => trashOrDelete() },
    { shortcut: { key: 'Delete', shift: true }, onShortcut: () => trashOrDelete(true) },
  ]}
/>

<IconButton
  color="secondary"
  shape="round"
  variant="ghost"
  icon={forceDefault ? mdiDeleteForeverOutline : mdiDeleteOutline}
  aria-label={forceDefault ? $t('permanently_delete') : $t('delete')}
  onclick={() => trashOrDelete()}
/>
