export { detectVolume } from './detect-volume';
export { detectMonotony } from './detect-monotony';
export { detectArousal } from './detect-arousal';
export { detectValence } from './detect-valence';
export { detectPace } from './detect-pace';
export { detectGroupEnergy } from './detect-group-energy';

import { FeedbackEventPayload } from '../../feedback.types';
import { ParticipantState, DetectionContext } from '../types';
import { detectVolume } from './detect-volume';
import { detectMonotony } from './detect-monotony';
import { detectPace } from './detect-pace';
import { detectArousal } from './detect-arousal';
import { detectValence } from './detect-valence';
import { detectGroupEnergy } from './detect-group-energy';

/**
 * Executa todas as heurísticas prosódicas na ordem de prioridade.
 * 
 * Ordem de execução:
 * 1. Volume (alto/baixo) - prioridade máxima (problema técnico)
 * 2. Monotonia Prosódica - verifica contexto com arousal
 * 3. Ritmo (acelerado/pausado) - verifica contexto com arousal
 * 4. Arousal (alto/baixo) - só se não há emoções primárias
 * 5. Valence (negativo) - só se não há emoções primárias
 * 6. Energia do Grupo - feedback de grupo
 * 
 * Verificações contextuais implementadas:
 * - Monotonia não detecta se arousal está extremo (alto/baixo) - é estado emocional claro, não monotonia
 * - Ritmo acelerado não detecta se arousal está muito baixo - contradição lógica
 * - Arousal e Valence só executam se não há emoções primárias - evita duplicação
 * - Volume e Ritmo detectam conflitos internos (alto/baixo, acelerado/pausado)
 * 
 * Retorna o primeiro feedback encontrado ou null se nenhum for detectado.
 */
export function run(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  // 3.1 Volume (RMS)
  const volumeResult = detectVolume(state, ctx);
  if (volumeResult) return volumeResult;

  // 3.2 Monotonia Prosódica (variância de arousal)
  const monotonyResult = detectMonotony(state, ctx);
  if (monotonyResult) return monotonyResult;

  // 3.3 Ritmo (acelerado/pausado)
  const paceResult = detectPace(state, ctx);
  if (paceResult) return paceResult;

  // 3.4 Arousal (alto/baixo) - só se não há emoções primárias
  // Nota: A verificação de emoções primárias é feita dentro de detectArousal
  const arousalResult = detectArousal(state, ctx);
  if (arousalResult) return arousalResult;

  // 3.5 Valence (negativo) - só se não há emoções primárias
  // Nota: A verificação de emoções primárias é feita dentro de detectValence
  const valenceResult = detectValence(state, ctx);
  if (valenceResult) return valenceResult;

  // 3.6 Energia do Grupo - feedback de grupo (menor prioridade)
  const groupEnergyResult = detectGroupEnergy(state, ctx);
  if (groupEnergyResult) return groupEnergyResult;

  return null;
}

