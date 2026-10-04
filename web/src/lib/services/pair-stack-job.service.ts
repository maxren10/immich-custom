import {
  getPairStackJob as getPairStackJobRequest,
  startPairStackJob as startPairStackJobRequest,
  type PairStackJobResponseDto,
} from '@immich/sdk';

export type PairStackJobRequest = {
  requestId: string;
  concurrency: number;
};

export const getPairStackJob = (): Promise<PairStackJobResponseDto> => getPairStackJobRequest();

export const startPairStackJob = ({ requestId, concurrency }: PairStackJobRequest) =>
  startPairStackJobRequest({
    pairStackJobCreateDto: {
      requestId,
      concurrency,
    },
  });
