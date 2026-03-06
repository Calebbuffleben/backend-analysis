export { DetectClientIndecision } from './detect-client-indecision';
export { DetectSolutionUnderstood } from './detect-solution-understood';
export { DetectSellerTalkingTooMuch } from './detect-seller-talking-too-much';

import { FeedbackEventPayload } from '../../feedback.types';
import { ParticipantState, DetectionContext } from '../types';
import { DetectClientIndecision } from './detect-client-indecision';
import { DetectSolutionUnderstood } from './detect-solution-understood';
import { DetectSellerTalkingTooMuch } from './detect-seller-talking-too-much';

export function run(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const indecisionFeedback = new DetectClientIndecision().run(state, ctx);
  if (indecisionFeedback) return indecisionFeedback;

  const sellerTalkingFeedback = new DetectSellerTalkingTooMuch().run(state, ctx);
  if (sellerTalkingFeedback) return sellerTalkingFeedback;

  const solutionUnderstoodFeedback = new DetectSolutionUnderstood().run(state, ctx);
  if (solutionUnderstoodFeedback) return solutionUnderstoodFeedback;

  return null;
}