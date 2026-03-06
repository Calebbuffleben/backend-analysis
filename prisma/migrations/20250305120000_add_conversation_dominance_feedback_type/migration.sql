DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'conversation_dominance';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
