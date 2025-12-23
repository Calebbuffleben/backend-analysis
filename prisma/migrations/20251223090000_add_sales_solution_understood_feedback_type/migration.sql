DO $$ BEGIN
  ALTER TYPE "FeedbackType" ADD VALUE 'sales_solution_understood';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;


