import {
  createUnmatchedPosBatch, getUnmatchedPosBatch, reviewUnmatchedPos,
  type UnmatchedPosDocument, type UnmatchedPosReviewInput,
} from '@workspace/api-client-react';

/** Keep the new POS workflow behind one typed boundary; generated API owns transport. */
export type ReviewItem = UnmatchedPosDocument;
export type ReviewAction = UnmatchedPosReviewInput;

export const posReviewApi = {
  createBatch: (files: { posPdfUrl: string; sourceFileName: string }[]) =>
    createUnmatchedPosBatch({ files }),
  batch: (batchId: string) => getUnmatchedPosBatch(batchId),
  review: (id: string, action: ReviewAction) => reviewUnmatchedPos(id, action),
};