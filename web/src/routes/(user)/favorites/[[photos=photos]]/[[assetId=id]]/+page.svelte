<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import ArchiveAction from '$lib/components/timeline/actions/ArchiveAction.svelte';
  import ChangeDate from '$lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeDescription from '$lib/components/timeline/actions/ChangeDescriptionAction.svelte';
  import ChangeLocation from '$lib/components/timeline/actions/ChangeLocationAction.svelte';
  import CreateSharedLink from '$lib/components/timeline/actions/CreateSharedLinkAction.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
  import SelectAllAssets from '$lib/components/timeline/actions/SelectAllAction.svelte';
  import SetVisibilityAction from '$lib/components/timeline/actions/SetVisibilityAction.svelte';
  import TagAction from '$lib/components/timeline/actions/TagAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import {
    createFavoriteRawDirectoryAccess,
    FavoriteRawDirectoryNeedsSelection,
    FavoriteRawWrongDirectory,
  } from '$lib/utils/favorite-raw-directory';
  import { syncFavoriteRaw } from '$lib/utils/favorite-raw-export';
  import { ActionButton, Button, CommandPaletteDefaultProvider } from '@immich/ui';
  import { mdiDotsVertical, mdiFolderDownloadOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  const options = { isFavorite: true, withStacked: true };
  let exportRunning = $state(false);
  let exportStatus = $state('');
  let directoryAccess: ReturnType<typeof createFavoriteRawDirectoryAccess> | undefined;

  onMount(() => {
    if (typeof showDirectoryPicker !== 'function') {
      return;
    }
    directoryAccess = createFavoriteRawDirectoryAccess(authManager.user.id, () =>
      showDirectoryPicker({ id: 'immich-favorite-raw', mode: 'readwrite' }),
    );
    void directoryAccess.warm();
  });

  const directoryError = (error: unknown) => {
    if (error instanceof FavoriteRawWrongDirectory) {
      exportStatus = $t('favorite_raw_export_choose_folder');
      return true;
    }
    if (error instanceof FavoriteRawDirectoryNeedsSelection) {
      exportStatus = $t('favorite_raw_export_select_again');
      return true;
    }
    return false;
  };

  const exportRaw = async () => {
    if (!directoryAccess) {
      exportStatus = $t('favorite_raw_export_unsupported');
      return;
    }

    exportRunning = true;
    let completed = 0;
    try {
      const { directory, remembered } = await directoryAccess.select();
      exportStatus = $t('favorite_raw_export_preparing');
      const result = await syncFavoriteRaw(directory, (done, total) => {
        completed = done;
        exportStatus = $t('favorite_raw_export_progress', { values: { done, total } });
      });
      exportStatus = $t('favorite_raw_export_done', {
        values: {
          copied: result.copied,
          existing: result.existing,
          removed: result.removed,
          changed: result.changed,
          missing: result.withoutRaw,
        },
      });
      if (!remembered) {
        exportStatus += ` ${$t('favorite_raw_export_not_remembered')}`;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'NotAllowedError')) {
        await directoryAccess.forget();
        exportStatus = $t('favorite_raw_export_select_again');
        return;
      }
      if (directoryError(error)) {
        return;
      }
      exportStatus = $t('favorite_raw_export_failed', {
        values: { done: completed, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      exportRunning = false;
    }
  };

  const changeRawDirectory = async () => {
    if (!directoryAccess) {
      exportStatus = $t('favorite_raw_export_unsupported');
      return;
    }
    try {
      const { remembered } = await directoryAccess.select(true);
      exportStatus = $t(remembered ? 'favorite_raw_export_folder_saved' : 'favorite_raw_export_not_remembered');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      if (!directoryError(error)) {
        exportStatus = $t('favorite_raw_export_failed', {
          values: { done: 0, error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  };

  const handleEscape = () => {
    if (!assetMultiSelectManager.selectionActive) {
      return;
    }

    assetMultiSelectManager.clear();
    return;
  };

  const handleSetVisibility = (assetIds: string[]) => {
    timelineManager.removeAssets(assetIds);
    assetMultiSelectManager.clear();
  };
</script>

<UserPageLayout
  hideNavbar={assetMultiSelectManager.selectionActive}
  title={data.meta.title}
  description={exportStatus}
  scrollbar={false}
>
  {#snippet buttons()}
    <Button
      variant="ghost"
      size="small"
      leadingIcon={mdiFolderDownloadOutline}
      disabled={exportRunning}
      onclick={exportRaw}
    >
      {$t('favorite_raw_export_button')}
    </Button>
    <Button variant="ghost" size="small" disabled={exportRunning} onclick={changeRawDirectory}>
      {$t('favorite_raw_export_change_folder')}
    </Button>
  {/snippet}
  <Timeline
    enableRouting={true}
    withStacked={true}
    bind:timelineManager
    {options}
    assetInteraction={assetMultiSelectManager}
    onEscape={handleEscape}
  >
    {#snippet empty()}
      <EmptyPlaceholder text={$t('no_favorites_message')} class="mx-auto mt-10" />
    {/snippet}
  </Timeline>
</UserPageLayout>

<!-- Multiselection mode app bar -->
{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    {@const Actions = getAssetBulkActions($t)}
    <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />
    <FavoriteAction removeFavorite onFavorite={(assetIds) => timelineManager.removeAssets(assetIds)} />
    <CreateSharedLink />
    <SelectAllAssets {timelineManager} assetInteraction={assetMultiSelectManager} />
    <ActionButton action={Actions.AddToAlbum} />
    <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
      <DownloadAction menuItem />
      <ChangeDate menuItem />
      <ChangeDescription menuItem />
      <ChangeLocation menuItem />
      <ArchiveAction
        menuItem
        unarchive={assetMultiSelectManager.isAllArchived}
        onArchive={(ids, visibility) => timelineManager.update(ids, (asset) => (asset.visibility = visibility))}
      />
      {#if authManager.preferences.tags.enabled}
        <TagAction menuItem />
      {/if}
      <SetVisibilityAction menuItem onVisibilitySet={handleSetVisibility} />
      <DeleteAssets
        menuItem
        onAssetDelete={(assetIds) => timelineManager.removeAssets(assetIds)}
        onUndoDelete={(assets) => timelineManager.upsertAssets(assets)}
      />
    </ButtonContextMenu>
  </AssetSelectControlBar>
{/if}
