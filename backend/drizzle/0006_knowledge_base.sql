CREATE TABLE "sources" (
  "id" text PRIMARY KEY NOT NULL,
  "subject_id" text NOT NULL REFERENCES "subjects"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('video','slides','textbook')),
  "title" text NOT NULL,
  "provider" text,
  "url" text,
  "license" text,
  "duration_sec" integer,
  "unit_count" integer,
  "content_hash" text,
  "ingested_at" timestamp with time zone,
  "ingest_report" jsonb
);
--> statement-breakpoint
CREATE TABLE "source_chunks" (
  "id" text PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "modality" text NOT NULL CHECK ("modality" IN ('transcript','page_text','slide_vision','keyframe_vision')),
  "locator" jsonb NOT NULL,
  "heading" text,
  "text" text NOT NULL,
  "visual_description" text,
  "asset_path" text,
  "subtopic_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "concept_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "tag_similarity" numeric(4,3),
  "low_information" boolean DEFAULT false NOT NULL,
  "embedding" vector(1536),
  "tsv" tsvector
);
--> statement-breakpoint
CREATE UNIQUE INDEX "source_chunks_source_seq_idx" ON "source_chunks" ("source_id","seq");
--> statement-breakpoint
CREATE INDEX "source_chunks_subtopic_ids_idx" ON "source_chunks" USING gin ("subtopic_ids");
--> statement-breakpoint
CREATE INDEX "source_chunks_tsv_idx" ON "source_chunks" USING gin ("tsv");
--> statement-breakpoint
CREATE TABLE "tutor_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "students"("id"),
  "started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "tutor_sessions"("id"),
  "student_id" uuid NOT NULL,
  "asked_at" timestamp with time zone NOT NULL,
  "question" text NOT NULL,
  "subtopic_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "mode" text CHECK ("mode" IN ('explain','connect','challenge')),
  "retrieval_mode" text CHECK ("retrieval_mode" IN ('hybrid','lexical')),
  "retrieved_chunk_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "answer" jsonb,
  "validation_report" jsonb,
  "repair_rounds" smallint DEFAULT 0 NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('answered','extractive_fallback','declined_no_evidence','declined_kb_down')),
  "context_assessment_id" uuid,
  "context_question_id" text,
  "trace" jsonb,
  "latency_ms" integer
);
--> statement-breakpoint
CREATE INDEX "tutor_turns_student_asked_idx" ON "tutor_turns" ("student_id","asked_at" DESC);
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "origin" text DEFAULT 'seeded' NOT NULL CHECK ("origin" IN ('seeded','kb_generated'));
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "source_chunk_id" text REFERENCES "source_chunks"("id");
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "evidence_quote" text;
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "source_id" text REFERENCES "sources"("id");
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "locator_range" jsonb;
