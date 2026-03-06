export { DetectClientIndecision } from './detect-client-indecision';
export { DetectSolutionUnderstood } from './detect-solution-understood';
export { DetectConversationDominance } from './detect-conversation-dominance';

import { FeedbackEventPayload } from '../../feedback.types';
import { ParticipantState, DetectionContext } from '../types';
import { DetectClientIndecision } from './detect-client-indecision';
import { DetectSolutionUnderstood } from './detect-solution-understood';
import { DetectConversationDominance } from './detect-conversation-dominance';

export function run(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const indecisionFeedback = new DetectClientIndecision().run(state, ctx);
  if (indecisionFeedback) return indecisionFeedback;

  const dominanceFeedback = new DetectConversationDominance().run(state, ctx);
  if (dominanceFeedback) return dominanceFeedback;

  const solutionUnderstoodFeedback = new DetectSolutionUnderstood().run(state, ctx);
  if (solutionUnderstoodFeedback) return solutionUnderstoodFeedback;

  return null;
}