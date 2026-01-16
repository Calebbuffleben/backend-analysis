import { TextAnalysisResult } from "@/pipeline/text-analysis.service";
import { DetectionContext, ParticipantState } from "../types";
import { FeedbackEventPayload } from "@/feedback/feedback.types";
import { Logger } from "@nestjs/common";

export type ParticipantRoles = 'host' | 'guest';

type MeetingMaps = {
  trackToParticipant: Map<string, string>;
  participantToRoles: Map<string, Set<ParticipantRoles>>;
  participantToName: Map<string, string>;
};

export class DetectClientIndecision {
  private readonly logger = new Logger(DetectClientIndecision.name);
  private readonly byMeeting = new Map<string, MeetingMaps>();

  /**
   * API pública no padrão A2E2: (state, ctx) -> FeedbackEventPayload | null
   *
   * Mantém o core da lógica no método privado (paridade com o Aggregator),
   * apenas montando um `TextAnalysisResult` mínimo a partir de `state` + `ctx`.
   */
  run(state: ParticipantState, ctx: DetectionContext): FeedbackEventPayload | null {
    const meetingId = ctx.meetingId;
    const participantId = ctx.participantId;
    const now = ctx.now;

    this.logger.log(`🔴 [INDECISION] Detector called for ${meetingId}/${participantId}`);

    // Verificação de role: Só bloqueia se tiver CERTEZA ABSOLUTA de que é host.
    // Se a função não existir ou retornar qualquer coisa diferente de 'host',
    // permite continuar (assume que pode ser cliente). Isso evita bloquear quando
    // o role ainda não foi identificado corretamente ou quando há incerteza.
    // 
    // IMPORTANTE: getParticipantRole retorna 'unknown' quando participante não encontrado.
    // Isso NÃO deve bloquear a detecção, pois pode ser um cliente ainda não identificado.
    const role = ctx.getParticipantRole?.(meetingId, participantId);
    
    // Só bloqueia se for EXATAMENTE 'host' E a função estiver disponível.
    // Qualquer outro valor ('guest', 'unknown', undefined, null) ou função ausente,
    // permite continuar a detecção.
    if (ctx.getParticipantRole && role === 'host') {
      this.logger.debug('❌ [INDECISION] Skipping host participant (confirmed host role)');
      return null;
    }
    
    // Para qualquer outro caso ('guest', 'unknown', undefined, null, ou função ausente),
    // continua a detecção assumindo que pode ser um cliente

    // Preencher nome do participante no mapa local (usado na montagem do payload).
    const participantName = ctx.getParticipantName(meetingId, participantId);
    if (participantName) {
      this.byMeeting.set(meetingId, {
        trackToParticipant: new Map<string, string>(),
        participantToRoles: new Map<string, Set<ParticipantRoles>>(),
        participantToName: new Map<string, string>([[participantId, participantName]]),
      });
    }

    const latestText = state.textAnalysis?.textHistory?.slice(-1)[0]?.text || '';

    this.logger.log(`[INDECISION] Latest text: "${latestText.substring(0, 100)}..."`);
    this.logger.log(`[INDECISION] Text history length: ${state.textAnalysis?.textHistory?.length || 0}`);

    // O detector só usa meetingId/participantId/text e lê o resto via state.textAnalysis.
    const evt = {
      meetingId,
      participantId,
      text: latestText,
      timestamp: now,
      analysis: {
        embedding: state.textAnalysis?.embedding ?? [],
        keywords: state.textAnalysis?.keywords ?? [],
        speech_act: state.textAnalysis?.speech_act ?? '',
      },
    } as unknown as TextAnalysisResult;

    const feedback = this.detectClientIndecision(state, evt, now);
    if (feedback && !feedback.participantName && participantName) {
      feedback.participantName = participantName;
    }
    return feedback;
  }

  private detectClientIndecision(
    state: ParticipantState,
    evt: TextAnalysisResult,
    now: number,
  ): FeedbackEventPayload | null {
    this.logger.debug('🔍 [INDECISION] Checking client indecision...', {
      meetingId: evt.meetingId,
      participantId: evt.participantId,
    });

    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      this.logger.debug('❌ [INDECISION] No text analysis data');
      return null;
    }
    
    // PRIORIDADE 3: Permitir detecção mesmo com histórico vazio se houver sinal forte no chunk atual
    // Garantir que textHistory existe
    const textHistory = textAnalysis.textHistory ?? [];
    
    // PRIORIDADE 3: Se histórico vazio, verificar se chunk atual tem sinal forte o suficiente
    if (textHistory.length === 0) {
      const currentIntensity = textAnalysis.sales_category_intensity ?? 0;
      const currentCategory = textAnalysis.sales_category;
      const hasStrongSignal = currentCategory && 
                              ['stalling', 'objection_soft'].includes(currentCategory) &&
                              currentIntensity >= 0.30; // Threshold alto para detecção sem histórico
      
      if (!hasStrongSignal) {
        this.logger.debug('❌ [INDECISION] No text history available and current chunk has weak/absent signal', {
          textHistoryLength: 0,
          currentCategory,
          currentIntensity,
          minIntensityForDirectDetection: 0.30,
        });
        return null;
      }
      
      // PRIORIDADE 3: Sinal forte no chunk atual - permitir detecção mesmo sem histórico
      this.logger.debug('✅ [INDECISION] Allowing detection with empty history due to strong current signal', {
        textHistoryLength: 0,
        currentCategory,
        currentIntensity,
        note: 'PRIORIDADE 3: Strong signal (intensity >= 0.30) allows detection without history',
      });
      // Continua com histórico vazio (detectActiveIndecision() precisará lidar com isso)
    }
    
    // FASE 2: Validação de integridade do textHistory
    // Verificar se o histórico contém pelo menos uma entrada válida
    const historyWithCategory = textHistory.filter(entry => entry.sales_category).length;
    if (historyWithCategory === 0 && textHistory.length > 0) {
      this.logger.debug('⚠️ [INDECISION] Text history exists but has no entries with sales_category', {
        totalEntries: textHistory.length,
        entriesWithCategory: historyWithCategory,
        lastEntryText: textHistory[textHistory.length - 1]?.text?.substring(0, 50) ?? 'null',
        lastEntryCategory: textHistory[textHistory.length - 1]?.sales_category ?? null,
      });
    }
    
    // FASE 2: Validação de sincronização - verificar se o histórico não está muito desatualizado
    // Se o último chunk no histórico é muito antigo (> 5 segundos), pode indicar problema
    const lastEntryTimestamp = textHistory[textHistory.length - 1]?.timestamp;
    if (lastEntryTimestamp && now - lastEntryTimestamp > 5000) {
      this.logger.debug('⚠️ [INDECISION] Text history may be stale', {
        lastEntryTimestamp,
        now,
        ageMs: now - lastEntryTimestamp,
        ageSec: Math.round((now - lastEntryTimestamp) / 1000),
        historyLength: textHistory.length,
      });
    }

    // ========================================================================
    // Verificar cooldown (2 minutos)
    // ========================================================================
    // Evita spam de feedbacks de indecisão
    const indecisionCooldownMsRaw = process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS;
    const indecisionCooldownMs = indecisionCooldownMsRaw
      ? Number.parseInt(indecisionCooldownMsRaw, 10)
      : 120000;
    const effectiveIndecisionCooldownMs = Number.isFinite(indecisionCooldownMs)
      ? Math.max(0, indecisionCooldownMs)
      : 120000;

    // Se cooldown configurado é 0, não bloquear por cooldown (mesmo que tenha sobrado estado antigo).
    if (effectiveIndecisionCooldownMs > 0 && this.inCooldown(state, 'sales_client_indecision', now)) {
      const remainingMs = this.cooldownRemainingMs(state, 'sales_client_indecision', now);
      this.logger.debug('❌ [INDECISION] In cooldown', {
        remainingMs,
        remainingSec: Math.round(remainingMs / 1000),
      });
      return null;
    }

    // ========================================================================
    // Detectar indecisão ativa (janela curta de chunks)
    // ========================================================================
    // Nota: detectActiveIndecision() já valida se há chunks suficientes
    // e se há ≥ 1 sinal válido, então não precisamos verificar antes
    const activeIndecision = this.detectActiveIndecision(state, 5);

    if (!activeIndecision || !activeIndecision.isActive) {
      // PRIORIDADE 1: Log detalhado quando indecisão ativa não é detectada (usando intensity)
      const textAnalysis = state.textAnalysis;
      this.logger.debug('❌ [INDECISION] No active indecision detected', {
        signalsCount: activeIndecision?.signalsCount ?? 0,
        averageIntensity: activeIndecision?.averageIntensity?.toFixed(3) ?? '0.000',
        averageConfidence: activeIndecision?.averageConfidence?.toFixed(3) ?? '0.000',
        validSignals: activeIndecision?.validSignals?.map(s => ({
          category: s.category,
          intensity: s.intensity.toFixed(3),
          confidence: s.confidence.toFixed(3),
          text_preview: s.text.substring(0, 50),
        })) ?? [],
        reason: !activeIndecision ? 'detectActiveIndecision returned null' :
                activeIndecision.signalsCount < 1 ? `Only ${activeIndecision.signalsCount} valid signals (need >= 1)` :
                activeIndecision.averageIntensity < 0.10 ? `Average intensity ${activeIndecision.averageIntensity.toFixed(3)} too low` :
                'unknown',
        textHistoryLength: textAnalysis?.textHistory?.length ?? 0,
        currentSalesCategory: textAnalysis?.sales_category ?? null,
        currentSalesCategoryIntensity: textAnalysis?.sales_category_intensity?.toFixed(3) ?? null,
        currentSalesCategoryConfidence: textAnalysis?.sales_category_confidence?.toFixed(3) ?? null,
        note: 'PRIORIDADE 1: Validation uses average INTENSITY, not confidence',
      });
      return null;
    }

    // PRIORIDADE 1: Confidence passa a ser a média de INTENSITY (não confidence) dos sinais válidos
    // Nota: detectActiveIndecision() já garante que se isActive: true,
    // então averageIntensity >= dynamicMinAverageIntensity (dinâmico), então não precisamos verificar novamente
    const confidence = activeIndecision.averageIntensity; // PRIORIDADE 1: Usar intensity como confidence final

    // FASE 4: Log detalhado de confidence final e métricas relacionadas
    // Nota: textAnalysis já foi declarado anteriormente no escopo da função
    const indecisionMetrics = textAnalysis?.indecision_metrics;
    const salesCategoryFlags = textAnalysis?.sales_category_flags;
    
    this.logger.debug('📊 [INDECISION] Active indecision intensity and metrics', {
      confidence: confidence.toFixed(3), // PRIORIDADE 1: confidence é na verdade averageIntensity
      averageIntensity: activeIndecision.averageIntensity.toFixed(3),
      averageConfidence: activeIndecision.averageConfidence.toFixed(3),
      signalsCount: activeIndecision.signalsCount,
      validSignalsDetails: activeIndecision.validSignals.map(s => ({
        category: s.category,
        intensity: s.intensity.toFixed(3),
        confidence: s.confidence.toFixed(3),
        text_preview: s.text.substring(0, 50),
      })),
      indecision_metrics: indecisionMetrics ? {
        indecision_score: indecisionMetrics.indecision_score?.toFixed(3) ?? null,
        postponement_likelihood: indecisionMetrics.postponement_likelihood?.toFixed(3) ?? null,
        conditional_language_score: indecisionMetrics.conditional_language_score?.toFixed(3) ?? null,
      } : null,
      sales_category_flags: salesCategoryFlags ? {
        price_window_open: salesCategoryFlags.price_window_open ?? false,
        decision_signal_strong: salesCategoryFlags.decision_signal_strong ?? false,
        ready_to_close: salesCategoryFlags.ready_to_close ?? false,
        indecision_detected: salesCategoryFlags.indecision_detected ?? false,
        decision_postponement_signal: salesCategoryFlags.decision_postponement_signal ?? false,
        conditional_language_signal: salesCategoryFlags.conditional_language_signal ?? false,
      } : null,
      current_sales_category: textAnalysis?.sales_category ?? null,
      current_sales_category_confidence: textAnalysis?.sales_category_confidence?.toFixed(3) ?? null,
    });

    // ========================================================================
    // Extrair frases representativas
    // ========================================================================
    // Obtém frases que exemplificam o padrão de indecisão
    // Extrair frases representativas (threshold baixo: este passo é explicativo,
    // não deve bloquear o envio do feedback quando os padrões já foram detectados).
    let representativePhrases = this.extractRepresentativePhrases(
      state,
      5,     // Últimos 5 chunks
      5,     // Máximo 5 frases
      0.15   // Confiança mínima
    );

    // Fallback: se não houver frases no histórico (ex.: confidence muito baixo),
    // use um trecho do texto atual para não bloquear a entrega do feedback.
    if (representativePhrases.length === 0) {
      const current = (evt.text || '').trim();
      if (current) {
        const maxLen = 180;
        const snippet = current.length > maxLen ? `${current.slice(0, maxLen - 3)}...` : current;
        representativePhrases = [snippet];
      }
    }

    this.logger.debug('💬 [INDECISION] Representative phrases', {
      count: representativePhrases.length,
      phrases: representativePhrases.slice(0, 3), // Mostrar apenas as 3 primeiras
    });

    // Não bloquear envio por falta de frases (isso é explicativo/metadata).
    // Se não houver frases, seguimos com metadata vazia.

    this.logger.log('✅ [INDECISION] All conditions met! Generating feedback...', {
      confidence,
      signalsCount: activeIndecision.signalsCount,
      phrasesCount: representativePhrases.length,
    });

    this.logger.log('📣 [INDECISION] Will generate humanized feedback', {
      meetingId: evt.meetingId,
      participantId: evt.participantId,
    });

    // ========================================================================
    // Construir mensagem curta e direta
    // ========================================================================
    // Mensagem simplificada baseada na indecisão ativa detectada
    const message = '⏳ Cliente demonstrando indecisão';

    // ========================================================================
    // Construir tips curtas e práticas (máximo 2)
    // ========================================================================
    const tips: string[] = [];

    // Tip baseado no número de sinais detectados
    if (activeIndecision.signalsCount >= 3) {
      tips.push('Crie urgência ou ofereça incentivo');
    } else {
      tips.push('Pergunte o que está travando');
    }

    // Adicionar uma dica de ação
    tips.push('Proponha próximo passo concreto');

    // ========================================================================
    // Gerar feedback
    // ========================================================================
    const window = this.window(state, now, 60000); // Últimos 60s
    if (effectiveIndecisionCooldownMs > 0) {
      this.setCooldown(
        state,
        'sales_client_indecision',
        now,
        effectiveIndecisionCooldownMs,
      );
    }

    return {
      id: this.makeId(),
      type: 'sales_client_indecision',
      severity: 'warning',
      ts: now,
      meetingId: evt.meetingId,
      participantId: evt.participantId,
      participantName: this.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
      window: { start: window.start, end: window.end },
      message,
      tips,
      metadata: {
        confidence: Math.round(confidence * 100) / 100, // Arredondar para 2 casas decimais
        valid_signals_count: activeIndecision.signalsCount,
        valid_signals_average_confidence: Math.round(activeIndecision.averageConfidence * 100) / 100,
        representative_phrases: representativePhrases,
        sales_category: textAnalysis.sales_category ?? undefined,
        sales_category_confidence: textAnalysis.sales_category_confidence ?? undefined,
        indecision_metrics: textAnalysis.indecision_metrics ?? undefined,
        conditional_keywords_detected: textAnalysis.conditional_keywords_detected ?? undefined,
      },
    };
  }

/**
 * Detecta padrões semânticos de indecisão baseado em análise contextual.
 * 
 * Analisa o estado atual do participante e identifica três padrões específicos:
 * 1. decision_postponement: Cliente consistentemente posterga decisões
 * 2. conditional_language: Cliente usa linguagem condicional/aberta
 * 3. lack_of_commitment: Cliente evita compromissos claros
 * 
 * @param state Estado do participante contendo análise de texto
 * @returns Objeto com três flags booleanas indicando quais padrões foram detectados
 * 
 * @example
 * ```typescript
 * const patterns = this.detectIndecisionPatterns(state);
 * if (patterns.decision_postponement) {
 *   // Cliente está postergando decisões
 * }
 * ```
 */
  private detectIndecisionPatterns(
    state: ParticipantState
  ): {
    decision_postponement: boolean;
    conditional_language: boolean;
    lack_of_commitment: boolean;
  } {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return {
        decision_postponement: false,
        conditional_language: false,
        lack_of_commitment: false,
      };
    }

    const aggregated = textAnalysis.sales_category_aggregated;
    const trend = textAnalysis.sales_category_trend;
    const ambiguity = textAnalysis.sales_category_ambiguity ?? 0;
    const keywords = textAnalysis.keywords ?? [];
    const flags = textAnalysis.sales_category_flags;
    const conditionalKeywordsDetected = textAnalysis.conditional_keywords_detected ?? [];
    const indecisionMetrics = textAnalysis.indecision_metrics;
    const indecisionScore = indecisionMetrics?.indecision_score ?? 0;
    const postponementLikelihood = indecisionMetrics?.postponement_likelihood ?? 0;
    const conditionalLanguageScore = indecisionMetrics?.conditional_language_score ?? 0;
    const currentCategory = textAnalysis.sales_category ?? null;
    const latestTextLower = (textAnalysis.textHistory?.slice(-1)[0]?.text ?? '').toLowerCase();

    // ========================================================================
    // Padrão 1: Decision Postponement
    // ========================================================================
    // Cliente consistentemente posterga decisões
    // 
    // Verifica:
    // 1. Flag do Python (decision_postponement_signal) OU
    // 2. Análise contextual (stalling + stable + low velocity)
    const pythonDecisionPostponementFlag = flags?.decision_postponement_signal ?? false;
    const isStallingDominant = aggregated?.dominant_category === 'stalling';
    const isStable = trend?.trend === 'stable';
    const isLowVelocity = (trend?.velocity ?? 1) < 0.1;
    const contextualDecisionPostponement = isStallingDominant && isStable && isLowVelocity;
    // 3. Métrica do Python (postponement_likelihood) acima de threshold
    const metricsDecisionPostponement = postponementLikelihood >= 0.6;
    // 4. Heurística lexical (mais robusta para fala real): categoria stalling + termos explícitos de adiamento
    // Obs: isso reduz a dependência de "confidence gap" do SBERT, que tende a ser baixo quando
    // stalling vs closing_readiness ficam próximos (ex.: transcrição parcial como "decidir agora").
    const postponementLexicon = [
      'adiar',
      'adiando',
      'postergar',
      'posterg',
      'protelar',
      'protelando',
      'deixar para depois',
      'deixar pra depois',
      'vou deixar para depois',
      'vou deixar pra depois',
      'depois eu decido',
      'depois a gente vê',
      'mais para frente',
      'mais pra frente',
      'não agora',
      'agora não',
      'preciso de mais tempo',
      'vou precisar de mais tempo',
      'não consigo decidir agora',
      'vou avaliar depois',
      'vou ver depois',
    ];
    const hasPostponementLexicon = postponementLexicon.some((p) => latestTextLower.includes(p));
    const hasAnyConditionalKeywordSignal =
      conditionalKeywordsDetected.length > 0 ||
      keywords.some((kw) =>
        ['talvez', 'pensar', 'avaliar', 'depois', 'ver', 'consultar', 'depende', 'preciso'].some((ck) =>
          kw.toLowerCase().includes(ck),
        ),
      );
    const lexicalDecisionPostponement =
      currentCategory === 'stalling' && (hasPostponementLexicon || hasAnyConditionalKeywordSignal);
    const decision_postponement =
      pythonDecisionPostponementFlag ||
      contextualDecisionPostponement ||
      metricsDecisionPostponement ||
      lexicalDecisionPostponement;

    // DEBUG: Log detailed decision_postponement analysis
    this.logger.log(`[INDECISION] decision_postponement analysis:`, {
      pythonDecisionPostponementFlag,
      contextualDecisionPostponement,
      metricsDecisionPostponement,
      lexicalDecisionPostponement,
      currentCategory,
      isStallingDominant,
      isStable,
      isLowVelocity,
      hasPostponementLexicon,
      hasAnyConditionalKeywordSignal,
      latestTextLower: latestTextLower.substring(0, 100),
    });

    // ========================================================================
    // Padrão 2: Conditional Language
    // ========================================================================
    // Cliente usa linguagem condicional/aberta
    // 
    // Verifica:
    // 1. Flag do Python (conditional_language_signal) OU
    // 2. Alta ambiguidade + conditional keywords detectadas pelo Python OU
    // 3. Alta ambiguidade + conditional keywords nas keywords gerais
    const pythonConditionalLanguageFlag = flags?.conditional_language_signal ?? false;
    const hasConditionalKeywordsFromPython = conditionalKeywordsDetected.length > 0;
    const conditionalKeywords = [
      'talvez',
      'pensar',
      'avaliar',
      'depois',
      'ver',
      'consultar',
      'depende',
      'preciso',
      'vou ver',
      'deixa',
      'analisar',
      'considerar',
      'refletir',
      'avaliar melhor',
      'pensar melhor',
    ];
    const hasConditionalKeywordsInGeneral = keywords.some(kw =>
      conditionalKeywords.some(ck => kw.toLowerCase().includes(ck))
    );
    const highAmbiguityWithKeywords = ambiguity > 0.7 && (hasConditionalKeywordsFromPython || hasConditionalKeywordsInGeneral);
    // 4. Métrica do Python (conditional_language_score) acima de threshold (>= 2 keywords ≈ 0.4)
    const metricsConditionalLanguage = conditionalLanguageScore >= 0.4;
    const conditional_language =
      pythonConditionalLanguageFlag || highAmbiguityWithKeywords || metricsConditionalLanguage;

    // ========================================================================
    // Padrão 3: Lack of Commitment
    // ========================================================================
    // Cliente evita compromissos claros
    // 
    // Verifica:
    // 1. Flag geral de indecisão do Python OU
    // 2. Análise contextual (baixa estabilidade + alta proporção de indecisão)
    // Nota: evitar depender diretamente de flags do Python para "lack_of_commitment":
    // elas podem oscilar com transcrição parcial e causar "cliente hesitante" como único feedback.
    // Preferimos sinais explícitos (lexical) e métricas/contexto.
    const stability = aggregated?.stability ?? 0;
    const distribution = aggregated?.category_distribution ?? {};
    const indecisionRatio = (distribution.stalling ?? 0) + (distribution.objection_soft ?? 0);
    const contextualLackOfCommitment = stability < 0.5 && indecisionRatio > 0.6;
    // 3. Métrica do Python (indecision_score) acima de threshold
    // Evitar interpretar "stalling" como "hesitação" por score quando não há sinais explícitos;
    // para stalling, preferimos o padrão decision_postponement.
    const metricsLackOfCommitment = indecisionScore >= 0.6 && currentCategory !== 'stalling';
    // 4. Heurística lexical: frases explícitas de falta de compromisso
    const lackOfCommitmentLexicon = [
      'não consigo me comprometer',
      'não vou me comprometer',
      'não quero me comprometer',
      'não tenho certeza',
      'não estou certo',
      'não estou certa',
      'não estou seguro',
      'não estou segura',
      'não estou pronto',
      'não estou pronta',
      'não consigo decidir',
    ];
    const lexicalLackOfCommitment = lackOfCommitmentLexicon.some((p) => latestTextLower.includes(p));
    const lack_of_commitment =
      lexicalLackOfCommitment || contextualLackOfCommitment || metricsLackOfCommitment;

    // LOG FINAL RESULTS
    this.logger.log(`[INDECISION] Pattern detection results:`, {
      decision_postponement,
      conditional_language,
      lack_of_commitment,
      currentCategory,
      latestTextLower: latestTextLower.substring(0, 100),
    });

    return {
      decision_postponement,
      conditional_language,
      lack_of_commitment,
    };
  }

  /**
   * Verifica se chunk é não semântico (mensagens de sistema, ruído claro).
   * 
   * NOTA: Este filtro é aplicado APENAS quando NÃO há classificação ML disponível.
   * Se o SBERT classificou o texto, a classificação ML tem prioridade (semântica > sintaxe).
   * 
   * Padrões detectados:
   * - "X segundos restantes" / "X minutos restantes" (mensagens de sistema explícitas)
   * - Textos muito curtos sem palavras significativas (ruído de transcrição)
   * 
   * REMOVIDO: Filtro de repetição (>50%) porque:
   * - Repetição pode ser legítima (hesitação, pensamento em voz alta)
   * - SBERT já analisa semanticamente e filtra por confiança
   * - Redundância desnecessária entre heurísticas e ML
   * 
   * @param text Texto do chunk
   * @returns true se chunk for não semântico
   */
  private isNonSemanticChunk(text: string): boolean {
    const textLower = text.toLowerCase().trim();
    
    // Padrão: "X segundos/minutos restantes" (mensagens de sistema explícitas)
    const timeRemainingPattern = /\d+\s*(segundos?|minutos?)\s*restantes?/i;
    if (timeRemainingPattern.test(textLower)) {
      return true;
    }
    
    // Textos muito curtos (< 10 caracteres) sem palavras significativas (ruído de transcrição)
    if (textLower.length < 10) {
      const words = textLower.split(/\s+/).filter(w => w.length > 0);
      // Lista de palavras muito comuns que não agregam significado
      const noiseWords = ['ok', 'ah', 'hmm', 'uh', 'é', 'sim', 'não', 'tá', 'entendi'];
      if (words.length <= 1 && noiseWords.some(noise => textLower.includes(noise))) {
        return true;
      }
    }
    
    // REMOVIDO: Filtro de repetição excessiva
    // - Repetição pode ser sinal legítimo de indecisão (hesitação)
    // - SBERT já classifica semanticamente e filtra por confiança
    // - Evita bloquear sinais válidos classificados pelo ML
    
    return false;
  }

  /**
   * Detecta indecisão ativa baseada em janela curta de chunks (3-5).
   * 
   * Regras:
   * - Avalia apenas últimos 3-5 chunks (não janela temporal)
   * - Ignora chunks não semânticos (tempo restante, mensagens de sistema)
   * - Chunk válido se: categoria ∈ {stalling, objection_soft} E confiança ≥ 0.15
   * - Indecisão ativa se: ≥ 1 sinal válido E confiança média ≥ 0.25
   * 
   * @param state Estado do participante
   * @param maxChunks Número máximo de chunks a avaliar (padrão: 5)
   * @returns Objeto com informações sobre indecisão ativa ou null
   */
  private detectActiveIndecision(
    state: ParticipantState,
    maxChunks: number = 5
  ): {
    isActive: boolean;
    validSignals: Array<{ text: string; category: string; intensity: number; confidence: number }>;
    averageIntensity: number;
    averageConfidence: number;
    signalsCount: number;
  } | null {
    // FASE 4: Log IMEDIATO no início para diagnóstico
    this.logger.debug('🔍 [ACTIVE_INDECISION] Method called', {
      hasTextAnalysis: !!state.textAnalysis,
      textHistoryLength: state.textAnalysis?.textHistory?.length ?? 0,
      maxChunks,
    });
    
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      this.logger.debug('🔍 [ACTIVE_INDECISION] No text analysis data - returning null');
      return null;
    }

    const textHistory = textAnalysis.textHistory ?? [];
    if (textHistory.length === 0) {
      this.logger.debug('🔍 [ACTIVE_INDECISION] No text history - returning null', {
        textHistoryIsUndefined: textAnalysis.textHistory === undefined,
        textHistoryIsNull: textAnalysis.textHistory === null,
        textHistoryLength: textHistory.length,
      });
      return null;
    }

    const indecisionCategories = ['stalling', 'objection_soft'];
    // PRIORIDADE 2: Threshold inicial reduzido para 0.05 (de 0.12) para capturar sinais fracos
    // Os thresholds dinâmicos serão aplicados APENAS na validação final (average intensity)
    const baseMinConfidence = 0.05; // Threshold base para coleta inicial (muito permissivo)
    const minSignals = 1; // Mínimo de sinais válidos

    // ========================================================================
    // Obter últimos N chunks (mais recentes primeiro)
    // ========================================================================
    const recentChunks = textHistory.slice(-maxChunks);

    // FASE 1: Log detalhado do conteúdo do textHistory
    this.logger.debug('🔍 [ACTIVE_INDECISION] Starting analysis', {
      totalHistoryLength: textHistory.length,
      recentChunksCount: recentChunks.length,
      maxChunks,
      minSignals,
      baseMinConfidence,
      indecisionCategories,
      recentChunksPreview: recentChunks.map(entry => ({
        text_preview: entry.text.substring(0, 50),
        sales_category: entry.sales_category,
        sales_category_confidence: entry.sales_category_confidence,
        timestamp: entry.timestamp,
      })),
    });

    // ========================================================================
    // Filtrar chunks não semânticos e extrair sinais válidos
    // ========================================================================
    // PRIORIDADE 1: Armazenar intensity (não confidence) para validação final
    const validSignals: Array<{ text: string; category: string; intensity: number; confidence: number }> = [];

    this.logger.debug('🔍 [ACTIVE_INDECISION] Analyzing chunks', {
      totalChunks: recentChunks.length,
      maxChunks,
    });

    let chunkIndex = 0;
    for (const entry of recentChunks) {
      chunkIndex++;
      
      // ========================================================================
      // Prioridade 1: Verificar classificação ML (SBERT) primeiro
      // ========================================================================
      // IMPORTANT: intensity is used for signal collection (semantic strength)
      // confidence is used only for final validation (class separation)
      // Do NOT use confidence for initial filtering
      //
      // Se o modelo ML classificou como indecisão com força semântica suficiente,
      // isso é a fonte mais confiável (ignora filtros heurísticos de texto)
      const category = entry.sales_category;
      const intensity = entry.sales_category_intensity; // Use intensity for collection
      const confidence = entry.sales_category_confidence; // Use confidence for validation only
      
      // FASE 1: Log detalhado de cada chunk analisado
      this.logger.debug(`🔍 [ACTIVE_INDECISION] Chunk ${chunkIndex}/${recentChunks.length}`, {
        text_preview: entry.text.substring(0, 80),
        sales_category: category,
        sales_category_intensity: intensity, // Used for collection
        sales_category_confidence: confidence, // Used for validation only
        category_type: typeof category,
        intensity_type: typeof intensity,
        confidence_type: typeof confidence,
        category_is_null: category === null,
        category_is_undefined: category === undefined,
        intensity_is_null: intensity === null,
        intensity_is_undefined: intensity === undefined,
        confidence_is_null: confidence === null,
        confidence_is_undefined: confidence === undefined,
      });
      
      // Verificar se tem classificação ML válida
      // IMPORTANT: Use intensity for collection (semantic strength), confidence for validation only
      // FASE 3: Usar threshold base para coleta inicial (thresholds dinâmicos aplicados depois)
      const hasCategory = category && category !== null;
      const hasIndecisionCategory = hasCategory && indecisionCategories.includes(category);
      const hasValidIntensity = intensity !== null && intensity !== undefined;
      const hasMinIntensity = hasValidIntensity && intensity >= baseMinConfidence; // Use intensity for collection
      
      const hasValidMLClassification = hasCategory && hasIndecisionCategory && hasValidIntensity && hasMinIntensity;
      
      // FASE 1: Log detalhado da validação ML
      if (!hasValidMLClassification) {
        this.logger.debug(`❌ [ACTIVE_INDECISION] Chunk ${chunkIndex} - ML classification invalid`, {
          hasCategory,
          hasIndecisionCategory,
          hasValidIntensity,
          hasMinIntensity,
          category,
          intensity,
          confidence,
          baseMinConfidence,
          reason: !hasCategory ? 'no_category' :
                  !hasIndecisionCategory ? 'not_indecision_category' :
                  !hasValidIntensity ? 'no_intensity' :
                  !hasMinIntensity ? `intensity_below_threshold (${intensity} < ${baseMinConfidence})` : 'unknown',
        });
      }
      
      if (hasValidMLClassification) {
        // Chunk válido baseado em classificação ML!
        // Nota: Mesmo se o texto tiver repetições ou outros padrões,
        // a classificação ML é a fonte de verdade (semântica > sintaxe)
        
        // FASE 1: Log quando chunk ML válido é encontrado
        // Note: Use intensity for collection, but store confidence for validation
        this.logger.debug(`✅ [ACTIVE_INDECISION] Chunk ${chunkIndex} - Valid ML classification found!`, {
          text_preview: entry.text.substring(0, 80),
          category,
          intensity, // Used for collection
          confidence, // Stored for validation only
          will_add_to_valid_signals: true,
        });
        
        // PRIORIDADE 1: Armazenar intensity (não confidence) para validação final
        // intensity representa força semântica real, confidence pode ser muito baixo
        const intensityForValidation = intensity ?? 0;
        const confidenceForLogging = confidence ?? 0;
        
        validSignals.push({
          text: entry.text,
          category,
          intensity: intensityForValidation, // PRIORIDADE 1: Usar intensity para validação
          confidence: confidenceForLogging, // Manter confidence apenas para logs
        });
        continue;
      }
      
      // ========================================================================
      // Prioridade 2: Aplicar filtros heurísticos apenas se NÃO há classificação ML
      // ========================================================================
      // Filtros heurísticos servem como fallback para casos onde não há
      // classificação ML disponível (mensagens de sistema, ruído de transcrição)
      const isNonSemantic = this.isNonSemanticChunk(entry.text);
      
      // FASE 1: Log quando chunk é filtrado heurístico
      if (isNonSemantic) {
        this.logger.debug(`🔍 [ACTIVE_INDECISION] Chunk ${chunkIndex} - Filtered by heuristic (non-semantic)`, {
          text_preview: entry.text.substring(0, 80),
          reason: 'isNonSemanticChunk returned true',
        });
      }
      
      if (isNonSemantic) {
        continue;
      }
      
      // Se chegou aqui, não tem classificação ML válida E passou filtros heurísticos
      // (Não adiciona aos validSignals porque precisa de classificação ML para detectar indecisão)
      
      // FASE 1: Log quando chunk não tem ML e não é filtrado (caso raro)
      this.logger.debug(`🔍 [ACTIVE_INDECISION] Chunk ${chunkIndex} - No ML classification and passed heuristics`, {
        text_preview: entry.text.substring(0, 80),
        note: 'Not added to validSignals (requires ML classification)',
      });
    }

    // ========================================================================
    // Verificar se há indecisão ativa
    // ========================================================================
    const signalsCount = validSignals.length;
    
    // PRIORIDADE 1: Calcular threshold dinâmico para validação final usando AVERAGE INTENSITY
    // IMPORTANTE: Não aplicamos threshold dinâmico na coleta individual para evitar filtragem dupla
    // O threshold dinâmico é aplicado APENAS na validação final (average intensity).
    // Thresholds adaptativos:
    // - 1 sinal: threshold 0.15 - permite feedbacks quando há padrão claro
    // - 2 sinais: threshold 0.12 - permite feedbacks quando há múltiplos sinais
    // - 3+ sinais: threshold 0.10 - permite feedbacks quando há padrão consistente
    // Lógica adaptativa: menos sinais = threshold mais alto (mais conservador)
    let dynamicMinAverageIntensity: number;
    
    if (signalsCount === 1) {
      // PRIORIDADE 1: Com apenas 1 sinal, ser mais conservador (threshold mais alto)
      dynamicMinAverageIntensity = 0.15;
    } else if (signalsCount >= 2 && signalsCount < 3) {
      // PRIORIDADE 1: Com 2 sinais, usar threshold médio
      dynamicMinAverageIntensity = 0.12;
    } else {
      // PRIORIDADE 1: Com 3+ sinais, ser mais permissivo (threshold mais baixo)
      dynamicMinAverageIntensity = 0.10;
    }
    
    // FASE 4: Log resumo da análise com informações detalhadas de diagnóstico
    this.logger.debug('📊 [ACTIVE_INDECISION] Analysis summary', {
      totalChunksAnalyzed: recentChunks.length,
      validSignalsCount: signalsCount,
      minSignalsRequired: minSignals,
      baseMinConfidence,
      dynamicMinAverageIntensity,
      note: 'PRIORIDADE 1: Dynamic threshold applied to average INTENSITY (not confidence)',
      validSignalsDetails: validSignals.map(s => ({
        category: s.category,
        intensity: s.intensity,
        intensity_formatted: s.intensity.toFixed(3),
        confidence: s.confidence,
        confidence_formatted: s.confidence.toFixed(3),
        text_preview: s.text.substring(0, 50),
      })),
      // FASE 4: Informações adicionais de diagnóstico
      collection_stats: {
        signals_collected: signalsCount,
        signals_min_required: minSignals,
        has_enough_signals: signalsCount >= minSignals,
        collection_threshold: baseMinConfidence,
      },
      validation_stats: {
        average_intensity_threshold: dynamicMinAverageIntensity,
        signals_count_for_threshold: signalsCount,
        note: 'PRIORIDADE 1: Validating average INTENSITY, not confidence',
      },
    });
    
    if (signalsCount < minSignals) {
      this.logger.debug('❌ [ACTIVE_INDECISION] Not enough valid signals', {
        signalsCount,
        minSignals,
        validSignals: validSignals.map(s => ({ category: s.category, confidence: s.confidence })),
        reason: `Found ${signalsCount} valid signals but need at least ${minSignals}`,
      });
      return {
        isActive: false,
        validSignals,
        averageIntensity: 0,
        averageConfidence: 0,
        signalsCount,
      };
    }

    // FASE 1: Removida filtragem dupla - não aplicamos threshold dinâmico individual
    // Todos os sinais coletados com baseMinConfidence são mantidos para cálculo da média
    // O threshold dinâmico é aplicado APENAS na validação final (average confidence)
    // Isso evita descartar sinais já coletados (ex: 1 sinal com 0.17 coletado com 0.15, mas descartado com 0.20)
    const filteredSignals = validSignals; // Todos os sinais coletados são mantidos
    const filteredSignalsCount = signalsCount; // Quantidade permanece a mesma

    // PRIORIDADE 1: Log antes do cálculo da média (intensity e confidence)
    this.logger.debug('📊 [ACTIVE_INDECISION] Before average calculation', {
      signals_collected: filteredSignalsCount,
      signals_maintained: filteredSignalsCount,
      note: 'No individual filtering - all collected signals are maintained',
      signals_intensity_values: filteredSignals.map(s => ({
        value: s.intensity,
        formatted: s.intensity.toFixed(3),
      })),
      signals_confidence_values: filteredSignals.map(s => ({
        value: s.confidence,
        formatted: s.confidence.toFixed(3),
      })),
    });

    // PRIORIDADE 1: Calcular média de INTENSITY (não confidence) para validação final
    const averageIntensity = filteredSignals.reduce((sum, s) => sum + s.intensity, 0) / filteredSignalsCount;
    
    // Calcular média de confidence apenas para logs e retrocompatibilidade
    const averageConfidence = filteredSignals.reduce((sum, s) => sum + s.confidence, 0) / filteredSignalsCount;

    // PRIORIDADE 1: Log após cálculo da média
    this.logger.debug('📊 [ACTIVE_INDECISION] Average calculated', {
      average_intensity: averageIntensity,
      average_intensity_formatted: averageIntensity.toFixed(3),
      average_confidence: averageConfidence,
      average_confidence_formatted: averageConfidence.toFixed(3),
      signals_count: filteredSignalsCount,
      intensity_sum: filteredSignals.reduce((sum, s) => sum + s.intensity, 0),
      confidence_sum: filteredSignals.reduce((sum, s) => sum + s.confidence, 0),
      dynamic_threshold: dynamicMinAverageIntensity,
      threshold_met: averageIntensity >= dynamicMinAverageIntensity,
      note: 'PRIORIDADE 1: Validating average INTENSITY, not confidence',
    });

    // PRIORIDADE 1: Aplicar threshold dinâmico APENAS na validação final usando AVERAGE INTENSITY
    // Este é o único lugar onde o threshold dinâmico é aplicado, evitando filtragem dupla
    if (averageIntensity < dynamicMinAverageIntensity) {
      // PRIORIDADE 1: Log detalhado com razão de bloqueio usando intensity
      const intensityValues = filteredSignals.map(s => s.intensity);
      const intensityGap = dynamicMinAverageIntensity - averageIntensity;
      const intensityGapPercentage = (intensityGap / dynamicMinAverageIntensity) * 100;
      
      this.logger.debug('❌ [ACTIVE_INDECISION] Average intensity too low (dynamic threshold)', {
        averageIntensity,
        averageIntensityFormatted: averageIntensity.toFixed(3),
        averageConfidence,
        averageConfidenceFormatted: averageConfidence.toFixed(3),
        dynamicMinAverageIntensity,
        signalsCount: filteredSignalsCount,
        intensityValues,
        intensityValuesFormatted: intensityValues.map(v => v.toFixed(3)),
        confidenceValues: filteredSignals.map(s => s.confidence),
        confidenceValuesFormatted: filteredSignals.map(s => s.confidence.toFixed(3)),
        // PRIORIDADE 1: Estatísticas de bloqueio usando intensity
        blocking_reason: `Average intensity ${averageIntensity.toFixed(3)} is below dynamic threshold ${dynamicMinAverageIntensity} (${filteredSignalsCount} signals)`,
        intensity_gap: intensityGap,
        intensity_gap_formatted: intensityGap.toFixed(3),
        intensity_gap_percentage: intensityGapPercentage.toFixed(1),
        note: 'PRIORIDADE 1: Dynamic threshold applied to average INTENSITY (not confidence)',
        // Resumo estatístico
        validation_summary: {
          signals_collected: filteredSignalsCount,
          signals_passed_validation: 0,
          signals_blocked_by_average_threshold: filteredSignalsCount,
          average_intensity: averageIntensity,
          average_confidence: averageConfidence,
          threshold_required: dynamicMinAverageIntensity,
          threshold_not_met: true,
        },
      });
      return {
        isActive: false,
        validSignals: filteredSignals,
        averageIntensity,
        averageConfidence,
        signalsCount: filteredSignalsCount,
      };
    }

    // PRIORIDADE 1: Indecisão ativa detectada!
    // Log detalhado com estatísticas completas de sucesso (usando intensity)
    this.logger.debug('✅ [ACTIVE_INDECISION] Active indecision detected', {
      signalsCount: filteredSignalsCount,
      averageIntensity,
      averageIntensityFormatted: averageIntensity.toFixed(3),
      averageConfidence,
      averageConfidenceFormatted: averageConfidence.toFixed(3),
      dynamicMinAverageIntensity,
      note: 'PRIORIDADE 1: Dynamic threshold applied to average INTENSITY (not confidence)',
      validSignals: filteredSignals.map(s => ({
        category: s.category,
        intensity: s.intensity,
        intensityFormatted: s.intensity.toFixed(3),
        confidence: s.confidence,
        confidenceFormatted: s.confidence.toFixed(3),
        text_preview: s.text.substring(0, 50),
      })),
      // Estatísticas de sucesso detalhadas usando intensity
      success_summary: {
        signals_collected: filteredSignalsCount,
        signals_passed_validation: filteredSignalsCount,
        average_intensity: averageIntensity,
        average_confidence: averageConfidence,
        threshold_required: dynamicMinAverageIntensity,
        threshold_met: true,
        intensity_margin: averageIntensity - dynamicMinAverageIntensity,
        intensity_margin_formatted: (averageIntensity - dynamicMinAverageIntensity).toFixed(3),
        intensity_margin_percentage: (((averageIntensity - dynamicMinAverageIntensity) / dynamicMinAverageIntensity) * 100).toFixed(1),
      },
    });

    return {
      isActive: true,
      validSignals: filteredSignals,
      averageIntensity,
      averageConfidence,
      signalsCount: filteredSignalsCount,
    };
  }

  private calculateTemporalConsistency(
    state: ParticipantState,
    now: number,
    windowMs: number = 60000 // Últimos 60 segundos
  ): boolean {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return false;
    }

    const textHistory = textAnalysis.textHistory ?? [];
    if (textHistory.length === 0) {
      return false;
    }

    const cutoffTime = now - windowMs;
    const indecisionCategories = ['stalling', 'objection_soft'];

    // ========================================================================
    // Filtrar textos dentro da janela temporal
    // ========================================================================
    const windowTexts = textHistory.filter(entry => entry.timestamp >= cutoffTime);
    if (windowTexts.length === 0) {
      this.logger.debug('⏱️ [TEMPORAL] No texts in time window');
      return false;
    }

    // ========================================================================
    // Contar textos com categoria de indecisão e confiança mínima
    // ========================================================================
    const indecisionTexts = windowTexts.filter(entry => {
      // Verificar se tem categoria de indecisão
      if (!entry.sales_category || !indecisionCategories.includes(entry.sales_category)) {
        return false;
      }

      // Verificar confiança mínima (>= 0.3) - mais permissivo
      if ((entry.sales_category_confidence ?? 0) < 0.3) {
        return false;
      }

      return true;
    });

    // ========================================================================
    // Verificar proporção mínima (50% dos chunks devem ser de indecisão) - mais permissivo
    // ========================================================================
    const indecisionRatio = indecisionTexts.length / windowTexts.length;
    const hasTemporalConsistency = indecisionRatio >= 0.5;

    // FASE 4: Log detalhado de proporção de chunks de indecisão na janela
    this.logger.debug('⏱️ [TEMPORAL] Consistency calculation', {
      windowTextsCount: windowTexts.length,
      indecisionTextsCount: indecisionTexts.length,
      indecisionRatio: indecisionRatio.toFixed(3),
      threshold: 0.5,
      hasTemporalConsistency,
      windowMs,
      cutoffTime,
      now,
    });

    if (!hasTemporalConsistency) {
      // FASE 4: Log quando proporção de indecisão é insuficiente
      this.logger.debug('❌ [TEMPORAL] Insufficient indecision ratio in window', {
        indecisionRatio: indecisionRatio.toFixed(3),
        threshold: 0.5,
        windowTextsCount: windowTexts.length,
        indecisionTextsCount: indecisionTexts.length,
        reason: `Only ${(indecisionRatio * 100).toFixed(1)}% of chunks are indecision (need >= 50%)`,
        windowTextsPreview: windowTexts.slice(-5).map(entry => ({
          text_preview: entry.text.substring(0, 50),
          sales_category: entry.sales_category,
          sales_category_confidence: entry.sales_category_confidence,
        })),
      });
      return false;
    }

    // ========================================================================
    // Verificar estabilidade da categoria dominante (>= 0.5)
    // ========================================================================
    // Estabilidade baixa indica alternância entre categorias, o que não é
    // consistente com um padrão de indecisão mantido ao longo do tempo
    const aggregated = textAnalysis.sales_category_aggregated;
    const stability = aggregated?.stability ?? 0;
    
    // FASE 4: Log quando estabilidade é insuficiente
    if (stability < 0.5) {
      this.logger.debug('❌ [TEMPORAL] Stability too low', {
        stability: stability.toFixed(3),
        threshold: 0.5,
        dominant_category: aggregated?.dominant_category ?? null,
        category_distribution: aggregated?.category_distribution ?? null,
        reason: `Stability ${stability.toFixed(3)} is below threshold 0.5 (indicates category alternation)`,
      });
      return false;
    }

    // ========================================================================
    // Verificar tendência estável (sem progresso ou regressão)
    // ========================================================================
    // Tendência estável indica que o padrão se mantém ao longo do tempo,
    // sem mudanças significativas na direção da conversa
    const trend = textAnalysis.sales_category_trend;
    const isStable = trend?.trend === 'stable';

    const finalTemporalConsistency = hasTemporalConsistency && stability >= 0.5 && isStable;

    // FASE 4: Log detalhado de tendência quando não é estável
    if (!isStable) {
      this.logger.debug('❌ [TEMPORAL] Trend is not stable', {
        trend: trend?.trend ?? 'unknown',
        isStable,
        trend_strength: trend?.trend_strength ?? null,
        current_stage: trend?.current_stage ?? null,
        velocity: trend?.velocity ?? null,
        reason: `Trend '${trend?.trend ?? 'unknown'}' is not 'stable' (requires stable trend)`,
      });
    }

    // FASE 4: Log resumo final da validação temporal
    this.logger.debug('⏱️ [TEMPORAL] Final consistency check', {
      hasTemporalConsistency,
      stability: stability.toFixed(3),
      isStable,
      finalTemporalConsistency,
      allChecksPassed: finalTemporalConsistency,
      failureReason: finalTemporalConsistency ? null : 
        (!hasTemporalConsistency ? 'insufficient_indecision_ratio' :
         (stability < 0.5 ? 'stability_too_low' :
          (!isStable ? 'trend_not_stable' : 'unknown'))),
    });

    return finalTemporalConsistency;
  }

  /**
   * Calcula confidence combinado para detecção de indecisão.
   * 
   * Combina múltiplos sinais de indecisão usando média ponderada:
   * - Padrões detectados (30%): número de padrões semânticos detectados
   * - Estabilidade (20%): estabilidade da categoria dominante
   * - Força da tendência (15%): quão forte é a tendência estável
   * - Volume de dados (15%): quantidade de chunks analisados
   * - Proporção de indecisão (10%): % de categorias de indecisão
   * - Consistência temporal (10%): se padrão se mantém ao longo do tempo
   * 
   * @param state Estado do participante contendo análise de texto
   * @param patterns Padrões semânticos detectados
   * @param temporalConsistency Consistência temporal do padrão
   * @returns Valor de confidence entre 0.0 e 1.0
   * 
   * @example
   * ```typescript
   * const patterns = this.detectIndecisionPatterns(state);
   * const consistency = this.calculateTemporalConsistency(state, now);
   * const confidence = this.calculateIndecisionConfidence(state, patterns, consistency);
   * // confidence será entre 0.0 e 1.0
   * ```
   */

  private calculateIndecisionConfidence(
    state: ParticipantState,
    patterns: {
      decision_postponement: boolean;
      conditional_language: boolean;
      lack_of_commitment: boolean;
    },
    temporalConsistency: boolean
  ): number {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return 0.0;
    }

    const aggregated = textAnalysis.sales_category_aggregated;
    const trend = textAnalysis.sales_category_trend;

    // ========================================================================
    // Base: número de padrões detectados (0 a 3)
    // ========================================================================
    // Quanto mais padrões detectados, maior a confiança de que há indecisão
    const patternsCount = Object.values(patterns).filter(Boolean).length;
    const patternsScore = patternsCount / 3.0; // Normalizar para 0.0 a 1.0

    // ========================================================================
    // Estabilidade da categoria dominante (0.0 a 1.0)
    // ========================================================================
    // Estabilidade alta indica que o padrão é consistente
    const stability = aggregated?.stability ?? 0;

    // ========================================================================
    // Força da tendência (0.0 a 1.0)
    // ========================================================================
    // Força alta indica que a tendência estável é bem definida
    const trendStrength = trend?.trend_strength ?? 0;

    // ========================================================================
    // Volume de dados (normalizado, 0.0 a 1.0)
    // ========================================================================
    // Mínimo 5 chunks, ideal 10+ chunks
    // Mais dados = maior confiança na análise
    const totalChunks = aggregated?.chunks_with_category ?? 0;
    const volumeScore = Math.min(1.0, totalChunks / 10.0);

    // ========================================================================
    // Proporção de categorias de indecisão (0.0 a 1.0)
    // ========================================================================
    // Quanto maior a proporção de categorias de indecisão, maior a confiança
    const distribution = aggregated?.category_distribution ?? {};
    const indecisionRatio = (distribution.stalling ?? 0) + (distribution.objection_soft ?? 0);

    // ========================================================================
    // Consistência temporal (0.0 ou 1.0)
    // ========================================================================
    // Se padrão se mantém consistente ao longo do tempo, aumenta confiança
    const consistencyScore = temporalConsistency ? 1.0 : 0.0;

    // ========================================================================
    // Força das métricas de indecisão do Python (0.0 a 1.0)
    // ========================================================================
    // Essas métricas são o sinal mais direto para "indecisão" e devem influenciar
    // o confidence final, senão a heurística fica dependente demais de agregações
    // (stability/trend) que podem demorar a estabilizar.
    const indecisionMetrics = textAnalysis.indecision_metrics;
    const metricsScore = Math.max(
      indecisionMetrics?.indecision_score ?? 0,
      indecisionMetrics?.postponement_likelihood ?? 0,
      indecisionMetrics?.conditional_language_score ?? 0,
    );

    // ========================================================================
    // Calcular confidence combinado (média ponderada)
    // ========================================================================
    // Pesos definidos baseados na importância de cada sinal:
    // - Padrões detectados: 30% (combinação de sinais semânticos)
    // - Métricas do Python: 25% (sinal direto de indecisão)
    // - Estabilidade: 15% (consistência do dominante)
    // - Força da tendência: 10% (quão bem definida é a tendência)
    // - Volume de dados: 10% (mais dados = mais confiança)
    // - Proporção de indecisão: 5% (stalling + objection_soft)
    // - Consistência temporal: 5% (padrão sustentado na janela)
    const confidence = (
      patternsScore * 0.30 +
      metricsScore * 0.25 +
      stability * 0.15 +
      trendStrength * 0.10 +
      volumeScore * 0.10 +
      indecisionRatio * 0.05 +
      consistencyScore * 0.05
    );

    // Garantir range [0, 1]
    return Math.max(0.0, Math.min(1.0, confidence));
  }

  private inCooldown(state: ParticipantState, type: string, now: number): boolean {
    const until = state.cooldownUntilByType.get(type);
    return typeof until === 'number' && until > now;
  }

  private cooldownRemainingMs(state: ParticipantState, type: string, now: number): number {
    const until = state.cooldownUntilByType.get(type);
    if (typeof until !== 'number') return 0;
    return Math.max(0, until - now);
  }

  private setCooldown(state: ParticipantState, type: string, now: number, ms: number): void {
    state.cooldownUntilByType.set(type, now + ms);
    state.lastFeedbackAt = now;
  }

  private makeId(): string {
    const rnd = Math.floor(Math.random() * 1e9).toString(36);
    return `${Date.now().toString(36)}-${rnd}`;
  }

  private window(
    state: ParticipantState,
    now: number,
    ms: number,
  ): {
    start: number;
    end: number;
    samplesCount: number;
    speechCount: number;
    meanRmsDbfs?: number;
  } {
    const start = now - ms;
    let samplesCount = 0;
    let speechCount = 0;
    let rmsSum = 0;
    let rmsN = 0;
    for (let i = state.samples.length - 1; i >= 0; i--) {
      const s = state.samples[i];
      if (s.ts < start) break;
      samplesCount++;
      if (s.speech) speechCount++;
      if (typeof s.rmsDbfs === 'number') {
        rmsSum += s.rmsDbfs;
        rmsN++;
      }
    }
    const meanRmsDbfs = rmsN > 0 ? rmsSum / rmsN : undefined;
    return { start, end: now, samplesCount, speechCount, meanRmsDbfs };
  }

  private extractRepresentativePhrases(
    state: ParticipantState,
    maxChunks: number = 5, // Últimos N chunks
    maxPhrases: number = 5,
    minConfidence: number = 0.15 // Threshold mais permissivo
  ): string[] {
    const textHistory = state.textAnalysis?.textHistory ?? [];
    if (textHistory.length === 0) {
      return [];
    }

    const indecisionCategories = ['stalling', 'objection_soft'];

    // Obter últimos N chunks (mais recentes primeiro)
    const recentChunks = textHistory.slice(-maxChunks);

    // Filtrar textos de indecisão
    // Prioridade: Classificação ML > Filtros heurísticos
    const indecisionTexts = recentChunks
      .filter(entry => {
        // Prioridade 1: Verificar classificação ML primeiro
        const category = entry.sales_category;
        const confidence = entry.sales_category_confidence;
        
        const hasValidMLClassification = 
          category && 
          category !== null && 
          indecisionCategories.includes(category) &&
          confidence !== null && 
          confidence !== undefined && 
          confidence >= minConfidence;
        
        if (hasValidMLClassification) {
          // Classificação ML válida - aceita mesmo se tiver padrões de texto
          return true;
        }
        
        // Prioridade 2: Aplicar filtros heurísticos apenas se NÃO há classificação ML
        // Se não tem classificação ML, não pode extrair frase representativa
        // (filtro heurístico apenas para evitar processamento desnecessário)
        if (this.isNonSemanticChunk(entry.text)) {
          return false;
        }
        
        // Se chegou aqui, não tem classificação ML válida E passou filtros heurísticos
        // Mas sem classificação ML, não temos frase representativa de indecisão
        return false;
      })
      // Ordenar por confiança (maior primeiro)
      .sort((a, b) => (b.sales_category_confidence ?? 0) - (a.sales_category_confidence ?? 0))
      // Limitar quantidade
      .slice(0, maxPhrases)
      // Extrair apenas o texto
      .map(entry => entry.text);

    return indecisionTexts;
  }

  getParticipantName(meetingId: string, participantIdentity: string): string | undefined {
    return this.byMeeting.get(meetingId)?.participantToName.get(participantIdentity);
  }

}