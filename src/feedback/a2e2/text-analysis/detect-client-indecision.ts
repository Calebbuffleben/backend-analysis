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

    // Só faz sentido detectar "indecisão do cliente" para o lado cliente (guest).
    // Se o backend conseguir identificar o host, evitamos falso positivo no vendedor.
    const role = ctx.getParticipantRole?.(meetingId, participantId);
    if (role === 'host') {
      this.logger.debug('❌ [INDECISION] Skipping host participant');
      return null;
    }

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
      this.logger.debug('❌ [INDECISION] No active indecision detected', {
        signalsCount: activeIndecision?.signalsCount ?? 0,
        averageConfidence: activeIndecision?.averageConfidence ?? 0,
      });
      return null;
    }

    // Confidence passa a ser a média dos sinais válidos
    // Nota: detectActiveIndecision() já garante que se isActive: true,
    // então averageConfidence >= 0.25, então não precisamos verificar novamente
    const confidence = activeIndecision.averageConfidence;

    this.logger.debug('📊 [INDECISION] Active indecision confidence', {
      confidence,
      signalsCount: activeIndecision.signalsCount,
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
   * Verifica se chunk é não semântico (ruído, mensagens de sistema, tempo restante).
   * 
   * Padrões detectados:
   * - "X segundos restantes" / "X minutos restantes"
   * - Mensagens de sistema curtas e sem contexto
   * - Textos muito curtos sem palavras significativas
   * 
   * @param text Texto do chunk
   * @returns true se chunk for não semântico
   */
  private isNonSemanticChunk(text: string): boolean {
    const textLower = text.toLowerCase().trim();
    
    // Padrão: "X segundos/minutos restantes"
    const timeRemainingPattern = /\d+\s*(segundos?|minutos?)\s*restantes?/i;
    if (timeRemainingPattern.test(textLower)) {
      return true;
    }
    
    // Textos muito curtos (< 10 caracteres) sem palavras significativas
    if (textLower.length < 10) {
      // Lista de palavras muito comuns que não agregam significado
      const noiseWords = ['ok', 'ah', 'hmm', 'uh', 'é', 'sim', 'não', 'tá', 'entendi'];
      const words = textLower.split(/\s+/).filter(w => w.length > 0);
      if (words.length <= 1 && noiseWords.some(noise => textLower.includes(noise))) {
        return true;
      }
    }
    
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
    validSignals: Array<{ text: string; category: string; confidence: number }>;
    averageConfidence: number;
    signalsCount: number;
  } | null {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return null;
    }

    const textHistory = textAnalysis.textHistory ?? [];
    if (textHistory.length === 0) {
      this.logger.debug('🔍 [ACTIVE_INDECISION] No text history');
      return null;
    }

    const indecisionCategories = ['stalling', 'objection_soft'];
    const minConfidence = 0.15; // Threshold mais permissivo
    const minSignals = 1; // Mínimo de sinais válidos
    const minAverageConfidence = 0.25; // Confiança média mínima

    // ========================================================================
    // Obter últimos N chunks (mais recentes primeiro)
    // ========================================================================
    const recentChunks = textHistory.slice(-maxChunks);

    this.logger.debug('🔍 [ACTIVE_INDECISION] Starting analysis', {
      totalHistoryLength: textHistory.length,
      recentChunksCount: recentChunks.length,
      maxChunks,
      minSignals,
      minConfidence,
      minAverageConfidence,
      indecisionCategories,
    });

    // ========================================================================
    // Filtrar chunks não semânticos e extrair sinais válidos
    // ========================================================================
    const validSignals: Array<{ text: string; category: string; confidence: number }> = [];

    this.logger.debug('🔍 [ACTIVE_INDECISION] Analyzing chunks', {
      totalChunks: recentChunks.length,
      maxChunks,
    });

    for (const entry of recentChunks) {
      // Ignorar chunks não semânticos
      if (this.isNonSemanticChunk(entry.text)) {
        this.logger.debug('🔍 [ACTIVE_INDECISION] Skipping non-semantic chunk', {
          text: entry.text.substring(0, 50),
        });
        continue;
      }

      // Verificar se tem categoria válida
      if (!entry.sales_category || !indecisionCategories.includes(entry.sales_category)) {
        this.logger.debug('🔍 [ACTIVE_INDECISION] Skipping chunk - invalid category', {
          category: entry.sales_category,
          validCategories: indecisionCategories,
          text: entry.text.substring(0, 50),
        });
        continue;
      }

      // Verificar confiança mínima
      const confidence = entry.sales_category_confidence ?? 0;
      if (confidence < minConfidence) {
        this.logger.debug('🔍 [ACTIVE_INDECISION] Skipping chunk - low confidence', {
          confidence,
          minConfidence,
          category: entry.sales_category,
          text: entry.text.substring(0, 50),
        });
        continue;
      }

      // Chunk válido!
      this.logger.debug('✅ [ACTIVE_INDECISION] Valid signal found', {
        category: entry.sales_category,
        confidence,
        text: entry.text.substring(0, 50),
      });
      validSignals.push({
        text: entry.text,
        category: entry.sales_category,
        confidence,
      });
    }

    // ========================================================================
    // Verificar se há indecisão ativa
    // ========================================================================
    const signalsCount = validSignals.length;
    
    if (signalsCount < minSignals) {
      this.logger.debug('🔍 [ACTIVE_INDECISION] Not enough valid signals', {
        signalsCount,
        minSignals,
        validSignals: validSignals.map(s => ({ category: s.category, confidence: s.confidence })),
      });
      return {
        isActive: false,
        validSignals,
        averageConfidence: 0,
        signalsCount,
      };
    }

    // Calcular confiança média
    const averageConfidence = validSignals.reduce((sum, s) => sum + s.confidence, 0) / signalsCount;

    if (averageConfidence < minAverageConfidence) {
      this.logger.debug('🔍 [ACTIVE_INDECISION] Average confidence too low', {
        averageConfidence,
        minAverageConfidence,
        signalsCount,
      });
      return {
        isActive: false,
        validSignals,
        averageConfidence,
        signalsCount,
      };
    }

    // Indecisão ativa detectada!
    this.logger.debug('✅ [ACTIVE_INDECISION] Active indecision detected', {
      signalsCount,
      averageConfidence,
      validSignals: validSignals.map(s => ({ category: s.category, confidence: s.confidence })),
    });

    return {
      isActive: true,
      validSignals,
      averageConfidence,
      signalsCount,
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

    this.logger.debug('⏱️ [TEMPORAL] Consistency calculation', {
      windowTextsCount: windowTexts.length,
      indecisionTextsCount: indecisionTexts.length,
      indecisionRatio,
      threshold: 0.5,
      hasTemporalConsistency
    });

    if (!hasTemporalConsistency) {
      return false;
    }

    // ========================================================================
    // Verificar estabilidade da categoria dominante (>= 0.5)
    // ========================================================================
    // Estabilidade baixa indica alternância entre categorias, o que não é
    // consistente com um padrão de indecisão mantido ao longo do tempo
    const aggregated = textAnalysis.sales_category_aggregated;
    const stability = aggregated?.stability ?? 0;
    if (stability < 0.5) {
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

    this.logger.debug('⏱️ [TEMPORAL] Final consistency check', {
      hasTemporalConsistency,
      stability,
      isStable,
      finalTemporalConsistency
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

    // Filtrar textos de indecisão (ignorar chunks não semânticos)
    const indecisionTexts = recentChunks
      .filter(entry => {
        // Ignorar chunks não semânticos
        if (this.isNonSemanticChunk(entry.text)) {
          return false;
        }

        // Verificar categoria (deve ser stalling ou objection_soft)
        if (!entry.sales_category || !indecisionCategories.includes(entry.sales_category)) {
          return false;
        }

        // Verificar confiança mínima
        if ((entry.sales_category_confidence ?? 0) < minConfidence) {
          return false;
        }

        return true;
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