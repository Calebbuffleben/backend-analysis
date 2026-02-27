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
  private readonly byMeeting = new Map<string, MeetingMaps>();

  run(state: ParticipantState, ctx: DetectionContext): FeedbackEventPayload | null {
    const meetingId = ctx.meetingId;
    const participantId = ctx.participantId;
    const now = ctx.now;

    // Verificação de role: Só bloqueia se tiver CERTEZA ABSOLUTA de que é host.
    // Se a função não existir ou retornar qualquer coisa diferente de 'host',
    // permite continuar (assume que pode ser cliente). Isso evita bloquear quando
    // o role ainda não foi identificado corretamente ou quando há incerteza.
    const role = ctx.getParticipantRole?.(meetingId, participantId);
    
    if (ctx.getParticipantRole && role === 'host') {
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
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return null;
    }
  
    // Essa função usa o cooldown configurado no env. 
    // Cooldown significa que o feedback não será gerado novamente dentro desse período.
    const indecisionCooldownMsRaw = process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS;
    const indecisionCooldownMs = indecisionCooldownMsRaw
      ? Number.parseInt(indecisionCooldownMsRaw, 10)
      : 120000;
    const effectiveIndecisionCooldownMs = Number.isFinite(indecisionCooldownMs)
      ? Math.max(0, indecisionCooldownMs)
      : 120000;
    if (effectiveIndecisionCooldownMs > 0 && this.inCooldown(state, 'sales_client_indecision', Date.now())) {
      return null;
    }

    // Verifica se o texto é o mesmo segmento do último feedback.
    const SAME_SEGMENT_WINDOW_MS = 60_000;
    const timeSinceLastTextFeedback = typeof state.lastFeedbackTextAt === 'number'
      ? now - state.lastFeedbackTextAt
      : Infinity;
    if (
      timeSinceLastTextFeedback < SAME_SEGMENT_WINDOW_MS &&
      state.lastFeedbackText &&
      this.textSimilar(state.lastFeedbackText, evt.text ?? '', 0.6)
    ) {
      return null;
    }

    // Rule 1: linguagem_condicional — conditional_language_score > 0.6
    // Verifica se a linguagem condicional é alta.
    const linguagem_condicional =
      (textAnalysis.indecision_metrics?.conditional_language_score ?? 0) > 0.6;

    // Rule 2: postergar_decisao — postponement_likelihood > 0.6
    // Verifica se a decisão está sendo postergada.
    const postergar_decisao =
      (textAnalysis.indecision_metrics?.postponement_likelihood ?? 0) > 0.6;

    // Rule 3: indecisao_persistente — stalling + intensity > 0.5 in 20s window
    // Verifica se a indecisão é persistente.
    const textHistory = textAnalysis.textHistory ?? [];
    const currentStalling = textAnalysis.sales_category === 'stalling';
    const currentIntensity = textAnalysis.sales_category_intensity ?? 0;
    const currentQualifies = currentStalling && currentIntensity > 0.5;
    const window20sMs = 20_000;
    const inWindow20s = textHistory.filter((e) => e.timestamp >= now - window20sMs);
    const hasInWindowStalling = inWindow20s.some(
      (e) => e.sales_category === 'stalling' && (e.sales_category_intensity ?? 0) > 0.5,
    );
    const indecisao_persistente =
      currentQualifies && (hasInWindowStalling || inWindow20s.length === 0);

    const anyRuleTriggered = linguagem_condicional || postergar_decisao || indecisao_persistente;
    if (!anyRuleTriggered) {
      return null;
    }

   // Calcula a confiança combinada das regras acima.
    const condScore = textAnalysis.indecision_metrics?.conditional_language_score ?? 0;
    const postScore = textAnalysis.indecision_metrics?.postponement_likelihood ?? 0;
    const confidence = Math.max(
      linguagem_condicional ? condScore : 0,
      postergar_decisao ? postScore : 0,
      indecisao_persistente ? currentIntensity : 0,
    );

    // Extrai frases representativas da indecisão.
    let representativePhrases = this.extractRepresentativePhrases(state, 5, 5, 0.15);
    if (representativePhrases.length === 0) {
      const current = (evt.text || '').trim();
      if (current) {
        const maxLen = 180;
        representativePhrases = [
          current.length > maxLen ? `${current.slice(0, maxLen - 3)}...` : current,
        ];
      }
    }

    // Calcula a janela de tempo para o feedback.
    const window = this.window(state, now, 60000);
    if (effectiveIndecisionCooldownMs > 0) {
      this.setCooldown(state, 'sales_client_indecision', now, effectiveIndecisionCooldownMs);
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
      message: '⏳ Cliente demonstrando indecisão',
      tips: ['Pergunte o que está travando', 'Proponha próximo passo concreto'],
      metadata: {
        confidence: Math.round(confidence * 100) / 100,
        representative_phrases: representativePhrases,
        sales_category: textAnalysis.sales_category ?? undefined,
        sales_category_confidence: textAnalysis.sales_category_confidence ?? undefined,
        indecision_metrics: textAnalysis.indecision_metrics ?? undefined,
        conditional_keywords_detected: textAnalysis.conditional_keywords_detected ?? undefined,
      },
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
    return false;
  }

  private textSimilar(a: string, b: string, threshold = 0.6): boolean {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    if (wordsA.size === 0 || wordsB.size === 0) return a === b;
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const containment = Math.max(intersection / wordsA.size, intersection / wordsB.size);
    return containment >= threshold;
  }

  private inCooldown(state: ParticipantState, type: string, now: number): boolean {
    const until = state.cooldownUntilByType.get(type);
    return typeof until === 'number' && until > now;
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
    const indecisionTexts = recentChunks
      .filter(entry => {
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