DO $$
BEGIN
  IF to_regclass('public.ai_fill_batch_test') IS NOT NULL THEN
    ALTER TABLE "ai_fill_batch_test" RENAME TO "listing_ai_fill_batch";
  END IF;
END $$;
