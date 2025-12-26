export { DetectClientIndecision } from './detect-client-indecision';
export { DetectSolutionUnderstood } from './detect-solution-understood';

import { FeedbackEventPayload } from '../../feedback.types';
import { ParticipantState, DetectionContext } from '../types';
import { DetectClientIndecision } from './detect-client-indecision';
import { DetectSolutionUnderstood } from './detect-solution-understood';

export function run(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const indecisionFeedback = new DetectClientIndecision().run(state, ctx);
  if (indecisionFeedback) return indecisionFeedback;

  const solutionUnderstoodFeedback = new DetectSolutionUnderstood().run(state, ctx);
  if (solutionUnderstoodFeedback) return solutionUnderstoodFeedback;

  return null;
}