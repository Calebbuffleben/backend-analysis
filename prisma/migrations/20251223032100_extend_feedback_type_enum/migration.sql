-- Extend FeedbackType enum to match runtime FeedbackEventPayload.type values.
-- IMPORTANT: Postgres enum ALTERs cannot run inside a transaction; Prisma runs this file as-is.

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'frustracao_crescente';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'entusiasmo_alto';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'monotonia_prosodica';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'energia_grupo_baixa';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'interrupcoes_frequentes';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'polarizacao_emocional';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'efeito_pos_interrupcao';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'ritmo_acelerado';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'ritmo_pausado';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A2E2 (emoções/estados primários)
DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'hostilidade';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'tedio';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'confusao';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'serenidade';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'conexao';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'tristeza';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'estado_mental';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Feedbacks de vendas (semântica)
DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'sales_price_window_open';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'sales_decision_signal';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'sales_ready_to_close';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'sales_objection_escalating';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'sales_conversation_stalling';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'sales_category_transition';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'sales_client_indecision';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


