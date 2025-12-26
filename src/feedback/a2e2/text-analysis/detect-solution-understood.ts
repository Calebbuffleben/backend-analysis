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

type SolutionContextEntry = {
    ts: number;
    participantId: string;
    role: 'host' | 'guest' | 'unknown';
    text: string;
    embedding: number[];
    keywords: string[];
    strength: number; // 0..1
};

export class DetectSolutionUnderstood {
    private readonly logger = new Logger(DetectSolutionUnderstood.name);
    private readonly byMeeting = new Map<string, MeetingMaps>();

    // Meeting-level "solution context" (host explanation turns) for reformulation detection
    private readonly solutionContextByMeeting = new Map<string, SolutionContextEntry[]>();

    /**
     * API pública no padrão A2E2: (state, ctx) -> FeedbackEventPayload | null
     *
     * O "solution context" verdadeiro é mantido no Aggregator e exposto via DetectionContext.
     * Aqui apenas fazemos um snapshot para a detecção atual (sem precisar de singleton).
     */
    run(state: ParticipantState, ctx: DetectionContext): FeedbackEventPayload | null {
        const meetingId = ctx.meetingId;
        const participantId = ctx.participantId;
        const now = ctx.now;

        // Snapshot do contexto de solução (host explanations) vindo do Aggregator.
        const solutionContext = ctx.getSolutionContextEntries?.(meetingId) ?? [];
        this.solutionContextByMeeting.set(meetingId, solutionContext as unknown as SolutionContextEntry[]);

        // Snapshot de nome/role do participante atual (usado para ignorar host e preencher payload).
        const participantName = ctx.getParticipantName(meetingId, participantId);
        const roleRaw = ctx.getParticipantRole?.(meetingId, participantId);
        const role = roleRaw === 'host' || roleRaw === 'guest' ? roleRaw : 'unknown';

        const maps: MeetingMaps = {
            trackToParticipant: new Map<string, string>(),
            participantToRoles: new Map<string, Set<ParticipantRoles>>(),
            participantToName: new Map<string, string>(),
        };
        if (participantName) maps.participantToName.set(participantId, participantName);
        if (role === 'host' || role === 'guest') {
            maps.participantToRoles.set(participantId, new Set<ParticipantRoles>([role]));
        }
        this.byMeeting.set(meetingId, maps);

        const latestText = state.textAnalysis?.textHistory?.slice(-1)[0]?.text || '';
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

        const feedback = this.detectClientSolutionUnderstood(state, evt, now);
        if (feedback && !feedback.participantName && participantName) {
            feedback.participantName = participantName;
        }
        return feedback;
    }

    private detectClientSolutionUnderstood(
        state: ParticipantState,
        evt: TextAnalysisResult,
        now: number,
    ): FeedbackEventPayload | null {
        const enabled = this.envBool('SALES_SOLUTION_UNDERSTOOD_ENABLED', false);
        if (!enabled) return null;
        const debug = this.envBool('SALES_SOLUTION_UNDERSTOOD_DEBUG', false);
    
        // Apenas avaliar se houver embedding e texto
        const text = (evt.text || '').trim();
        const embedding = evt.analysis.embedding;
        if (!text || !Array.isArray(embedding) || embedding.length === 0) {
          if (debug) this.logger.debug('❌ [SOLUTION_UNDERSTOOD] Missing text or embedding');
          return null;
        }
    
        // Evitar disparar no próprio host (quando roles existem)
        // Para "unknown", assumimos que pode ser guest e processamos (mais permissivo)
        const role = this.getParticipantRole(evt.meetingId, evt.participantId);
        if (debug) {
          this.logger.debug('🔍 [SOLUTION_UNDERSTOOD] Checking client reformulation', {
            meetingId: evt.meetingId,
            participantId: evt.participantId,
            role,
            textPreview: text.slice(0, 80),
            textLength: text.length,
          });
        }
        // Apenas pular se for explicitamente host
        if (role === 'host') {
          if (debug) this.logger.debug('❌ [SOLUTION_UNDERSTOOD] Skipping host turn');
          return null;
        }
    
        // Cooldown (por participante)
        const cooldownRaw = process.env.SALES_SOLUTION_UNDERSTOOD_COOLDOWN_MS;
        const cooldownParsed = cooldownRaw ? Number.parseInt(cooldownRaw.replace(/"/g, ''), 10) : 120000;
        const effectiveCooldownMs = Number.isFinite(cooldownParsed) ? Math.max(0, cooldownParsed) : 120000;
        if (effectiveCooldownMs > 0 && this.inCooldown(state, 'sales_solution_understood', now)) {
          if (debug) this.logger.debug('❌ [SOLUTION_UNDERSTOOD] In cooldown');
          return null;
        }
    
        const markers = this.detectReformulationMarkers(text);
        if (markers.length === 0) {
          if (debug) {
            this.logger.debug('❌ [SOLUTION_UNDERSTOOD] No reformulation markers', {
              textPreview: text.slice(0, 100),
              textLength: text.length,
            });
          }
          return null;
        }
        if (debug) {
          this.logger.debug('✅ [SOLUTION_UNDERSTOOD] Reformulation markers found', {
            markers,
            count: markers.length,
            textPreview: text.slice(0, 100),
          });
        }
    
        const minCharsRaw = process.env.SALES_SOLUTION_UNDERSTOOD_MIN_REFORMULATION_CHARS;
        const minCharsParsed = minCharsRaw ? Number.parseInt(minCharsRaw.replace(/"/g, ''), 10) : 40;
        const minChars = Number.isFinite(minCharsParsed) ? Math.max(10, minCharsParsed) : 40;
        if (text.length < minChars) {
          if (debug) this.logger.debug('❌ [SOLUTION_UNDERSTOOD] Text too short', { len: text.length, minChars });
          return null;
        }
    
        const contextEntries = this.getSolutionContextEntriesForDetection(evt.meetingId, evt.participantId, now);
        if (contextEntries.length === 0) {
          if (debug) {
            this.logger.debug('❌ [SOLUTION_UNDERSTOOD] No solution context available', {
              meetingId: evt.meetingId,
              participantId: evt.participantId,
              totalContextEntries: this.solutionContextByMeeting.get(evt.meetingId)?.length ?? 0,
            });
          }
          return null;
        }
        if (debug) {
          this.logger.debug('✅ [SOLUTION_UNDERSTOOD] Context available', {
            contextEntriesCount: contextEntries.length,
            contextRoles: contextEntries.map((e) => e.role),
            contextStrengths: contextEntries.map((e) => Math.round(e.strength * 100) / 100),
          });
        }
    
        const centroid = this.meanEmbedding(contextEntries.map((e) => e.embedding));
        if (!centroid) {
          if (debug) this.logger.debug('❌ [SOLUTION_UNDERSTOOD] Failed to build centroid');
          return null;
        }
    
        const similarityRaw = this.cosineSimilarity(embedding, centroid);
        // Safety: se não parece relacionado, não adianta continuar
        if (similarityRaw < 0.6) {
          if (debug) {
            this.logger.debug('❌ [SOLUTION_UNDERSTOOD] Similarity too low', {
              similarityRaw: Math.round(similarityRaw * 1000) / 1000,
              minRequired: 0.6,
            });
          }
          return null;
        }
        if (debug) {
          this.logger.debug('✅ [SOLUTION_UNDERSTOOD] Similarity OK', {
            similarityRaw: Math.round(similarityRaw * 1000) / 1000,
          });
        }
        const similarityScore = this.clamp01((similarityRaw - 0.55) / 0.25);
        const markerScore = this.clamp01(markers.length / 2);
        const contextStrength = contextEntries.reduce((acc, e) => acc + e.strength, 0) / contextEntries.length;
    
        const clientKeywords = evt.analysis.keywords ?? [];
        const contextKeywords = this.collectKeywords(contextEntries);
        const keywordOverlap = this.keywordOverlapCount(clientKeywords, contextKeywords);
        const keywordOverlapScore = this.clamp01(keywordOverlap / 3);
        // Mitigação de falso positivo: se não há overlap nenhum, exigir similarity bem alta
        if (keywordOverlap === 0 && similarityRaw < 0.72) {
          if (debug)
            this.logger.debug('❌ [SOLUTION_UNDERSTOOD] No keyword overlap and similarity < 0.72', {
              similarityRaw,
              keywordOverlap,
            });
          return null;
        }
    
        const speechAct = evt.analysis.speech_act;
        const speechActScore =
          speechAct === 'agreement' || speechAct === 'confirmation'
            ? 1.0
            : speechAct === 'ask_info'
              ? 0.5
              : 0.0;
    
        const confidence =
          similarityScore * 0.45 +
          markerScore * 0.20 +
          keywordOverlapScore * 0.15 +
          this.clamp01(contextStrength) * 0.15 +
          speechActScore * 0.05;
    
        const thresholdRaw = process.env.SALES_SOLUTION_UNDERSTOOD_THRESHOLD;
        const thresholdParsed = thresholdRaw ? Number.parseFloat(thresholdRaw.replace(/"/g, '')) : 0.7;
        const threshold = Number.isFinite(thresholdParsed) ? this.clamp01(thresholdParsed) : 0.7;
        if (confidence < threshold) {
          if (debug)
            this.logger.debug('❌ [SOLUTION_UNDERSTOOD] Confidence below threshold', {
              confidence,
              threshold,
              similarityRaw,
              keywordOverlap,
              markers,
              speechAct,
            });
          return null;
        }
    
        if (effectiveCooldownMs > 0) {
          this.setCooldown(state, 'sales_solution_understood', now, effectiveCooldownMs);
        }
    
        const window = this.window(state, now, 60000);
        const bestContext = contextEntries.reduce((best, cur) => (cur.strength > best.strength ? cur : best), contextEntries[0]);
    
        const contextExcerpt = this.snippet(bestContext.text, 180);
        const clientExcerpt = this.snippet(text, 180);
    
        if (debug) {
          this.logger.log('✅ [SOLUTION_UNDERSTOOD] Triggered', {
            meetingId: evt.meetingId,
            participantId: evt.participantId,
            confidence: Math.round(confidence * 100) / 100,
            threshold,
            similarityRaw: Math.round(similarityRaw * 1000) / 1000,
            keywordOverlap,
            markers,
          });
        }
    
        return {
          id: this.makeId(),
          type: 'sales_solution_understood',
          severity: 'info',
          ts: now,
          meetingId: evt.meetingId,
          participantId: evt.participantId,
          participantName: this.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
          window: { start: window.start, end: window.end },
          message: 'Cliente reformulou sua solução — parece que entendeu.',
          tips: ['Confirme: “Perfeito — é isso mesmo.”', 'Valide o próximo passo: “Faz sentido avançarmos?”'],
          metadata: {
            confidence: Math.round(confidence * 100) / 100,
            similarity_raw: Math.round(similarityRaw * 1000) / 1000,
            markers_detected: markers,
            keyword_overlap: keywordOverlap,
            solution_context_excerpt: contextExcerpt,
            client_reformulation_excerpt: clientExcerpt,
          },
        };
    }
    private envBool(key: string, defaultValue: boolean): boolean {
        const raw = process.env[key];
        if (raw === undefined || raw === null) return defaultValue;
        const v = raw.replace(/"/g, '').trim().toLowerCase();
        if (v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === 'on') return true;
        if (v === 'false' || v === '0' || v === 'no' || v === 'n' || v === 'off') return false;
        return defaultValue;
    }
    private detectReformulationMarkers(text: string): string[] {
        const t = text.toLowerCase();
        const markers = [
          'deixa eu ver se entendi',
          'só pra confirmar',
          'se eu entendi',
          'entendi então',
          'entendi que',
          'então vocês',
          'então o que você está dizendo é',
          'quer dizer que',
          'ou seja',
          'resumindo',
          'em resumo',
          'na prática então',
          'basicamente',
        ];
        const found: string[] = [];
        for (const m of markers) {
          if (t.includes(m)) found.push(m);
        }
        return found;
    }

    private inCooldown(state: ParticipantState, type: string, now: number): boolean {
        const until = state.cooldownUntilByType.get(type);
        return typeof until === 'number' && until > now;
    }

    private getSolutionContextEntriesForDetection(
        meetingId: string,
        currentParticipantId: string,
        now: number,
    ): SolutionContextEntry[] {
        const windowMsRaw = process.env.SALES_SOLUTION_CONTEXT_WINDOW_MS;
        const windowMsParsed = windowMsRaw ? Number.parseInt(windowMsRaw.replace(/"/g, ''), 10) : 90_000;
        const windowMs = Number.isFinite(windowMsParsed) ? Math.max(10_000, windowMsParsed) : 90_000;
        const cutoff = now - windowMs;
    
        const list = this.solutionContextByMeeting.get(meetingId) ?? [];
        return list
          .filter((e) => e.ts >= cutoff)
          .filter((e) => e.participantId !== currentParticipantId)
          .filter((e) => e.role === 'host' || e.role === 'unknown');
    }

    private meanEmbedding(vectors: number[][]): number[] | null {
        if (vectors.length === 0) return null;
        const dim = vectors[0].length;
        if (dim === 0) return null;
        for (const v of vectors) {
          if (v.length !== dim) return null;
        }
        const out = new Array<number>(dim).fill(0);
        for (const v of vectors) {
          for (let i = 0; i < dim; i++) {
            out[i] += v[i];
          }
        }
        for (let i = 0; i < dim; i++) {
          out[i] /= vectors.length;
        }
        return out;
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length === 0 || b.length === 0) return 0;
        if (a.length !== b.length) return 0;
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < a.length; i++) {
          const ai = a[i];
          const bi = b[i];
          dot += ai * bi;
          na += ai * ai;
          nb += bi * bi;
        }
        if (na === 0 || nb === 0) return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    private clamp01(x: number): number {
        if (x < 0) return 0;
        if (x > 1) return 1;
        return x;
    }

    private collectKeywords(entries: SolutionContextEntry[]): string[] {
        const set = new Set<string>();
        for (const e of entries) {
          for (const k of e.keywords) {
            const kk = k.trim().toLowerCase();
            if (kk) set.add(kk);
          }
        }
        return Array.from(set);
    }

    private keywordOverlapCount(clientKeywords: string[], contextKeywords: string[]): number {
        if (clientKeywords.length === 0 || contextKeywords.length === 0) return 0;
        const ctx = new Set(contextKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean));
        let count = 0;
        for (const k of clientKeywords) {
          const kk = k.trim().toLowerCase();
          if (!kk) continue;
          if (ctx.has(kk)) count++;
        }
        return count;
    }
    private setCooldown(state: ParticipantState, type: string, now: number, ms: number): void {
        state.cooldownUntilByType.set(type, now + ms);
        state.lastFeedbackAt = now;
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

    private snippet(text: string, maxLen: number): string {
        const t = (text || '').trim();
        if (!t) return '';
        if (t.length <= maxLen) return t;
        return `${t.slice(0, Math.max(0, maxLen - 3))}...`;
    }

    private makeId(): string {
        const rnd = Math.floor(Math.random() * 1e9).toString(36);
        return `${Date.now().toString(36)}-${rnd}`;
    }

    getParticipantName(meetingId: string, participantIdentity: string): string | undefined {
        return this.byMeeting.get(meetingId)?.participantToName.get(participantIdentity);
    }

    getParticipantRole(meetingId: string, participantId: string): 'host' | 'guest' | 'unknown' {
        const roles = this.byMeeting.get(meetingId)?.participantToRoles.get(participantId);
        if (!roles || roles.size === 0) return 'unknown';
        if (roles.has('host')) return 'host';
        if (roles.has('guest')) return 'guest';
        return 'unknown';
    }
}