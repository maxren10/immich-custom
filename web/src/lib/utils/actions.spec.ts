import { deleteAssets as deleteBulk, getStack, updateStack, type StackResponseDto } from '@immich/sdk';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { deleteAssetsStackAware } from './actions';

vi.mock(import('@immich/sdk'), async (importOriginal) => ({
  ...(await importOriginal()),
  deleteAssets: vi.fn(),
  getStack: vi.fn(),
  updateStack: vi.fn(),
}));

const primaryId = '00000000-0000-4000-a000-000000000001';
const secondaryId = '00000000-0000-4000-a000-000000000002';
const thirdId = '00000000-0000-4000-a000-000000000004';
const stackId = '00000000-0000-4000-a000-000000000003';

const timelineAsset = (id: string, assetCount = 2): TimelineAsset =>
  ({ id, stack: { id: stackId, primaryAssetId: primaryId, assetCount } }) as TimelineAsset;

const stack = {
  id: stackId,
  primaryAssetId: primaryId,
  assets: [{ id: primaryId }, { id: secondaryId }, { id: thirdId }],
} as StackResponseDto;

describe('deleteAssetsStackAware', () => {
  beforeEach(() => {
    vi.mocked(deleteBulk).mockReset();
    vi.mocked(getStack).mockReset();
    vi.mocked(updateStack).mockReset();
    vi.mocked(getStack).mockResolvedValue(stack);
  });

  it('promotes a surviving member before deleting the current primary', async () => {
    const updatedStack = { ...stack, primaryAssetId: secondaryId };
    const onStackPrimaryChange = vi.fn();
    vi.mocked(updateStack).mockResolvedValue(updatedStack);

    await deleteAssetsStackAware(false, [timelineAsset(primaryId, 3)], onStackPrimaryChange);

    expect(updateStack).toHaveBeenCalledWith({ id: stackId, stackUpdateDto: { primaryAssetId: secondaryId } });
    expect(deleteBulk).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: [primaryId], force: false } });
    expect(vi.mocked(updateStack).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deleteBulk).mock.invocationCallOrder[0],
    );
    expect(onStackPrimaryChange).toHaveBeenCalledWith(updatedStack);
  });

  it('deletes every secondary before deleting the primary when deleting the whole stack', async () => {
    await deleteAssetsStackAware(false, [
      timelineAsset(primaryId, 3),
      timelineAsset(secondaryId, 3),
      timelineAsset(thirdId, 3),
    ]);

    expect(updateStack).not.toHaveBeenCalled();
    expect(deleteBulk).toHaveBeenNthCalledWith(1, {
      assetBulkDeleteDto: { ids: [secondaryId, thirdId], force: false },
    });
    expect(deleteBulk).toHaveBeenNthCalledWith(2, {
      assetBulkDeleteDto: { ids: [primaryId], force: false },
    });
  });

  it('deletes a non-primary stack member directly', async () => {
    await deleteAssetsStackAware(false, [timelineAsset(secondaryId)]);

    expect(getStack).not.toHaveBeenCalled();
    expect(updateStack).not.toHaveBeenCalled();
    expect(deleteBulk).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: [secondaryId], force: false } });
  });
});
