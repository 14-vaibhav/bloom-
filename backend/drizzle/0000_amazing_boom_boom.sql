CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"phase" text NOT NULL,
	"event_type" text NOT NULL,
	"tool_name" text,
	"message" text NOT NULL,
	"payload" jsonb,
	"error_class" text,
	"retry_attempt" smallint DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"trigger" text NOT NULL,
	"scope" text NOT NULL,
	"outcome" text,
	"status" text DEFAULT 'running' NOT NULL,
	"last_completed_phase" smallint DEFAULT 0 NOT NULL,
	"degraded_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"error_class" text,
	"error_detail" text,
	"recovered_from_run_id" uuid,
	"new_plan_version" integer,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"llm_call_count" integer DEFAULT 0 NOT NULL,
	"total_latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assessment_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"score" numeric(4, 3) NOT NULL,
	"per_subtopic" jsonb NOT NULL,
	"per_concept" jsonb NOT NULL,
	"prediction_error" numeric(4, 3) NOT NULL,
	"answers" jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"activity_id" uuid,
	"purpose" text NOT NULL,
	"subtopic_ids" text[] NOT NULL,
	"question_ids" text[] NOT NULL,
	"composition" jsonb,
	"predicted_score" numeric(4, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"busy" boolean DEFAULT true NOT NULL,
	"activity_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "concepts" (
	"id" text PRIMARY KEY NOT NULL,
	"subtopic_id" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"summary_date" date NOT NULL,
	"message" text NOT NULL,
	"stats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"config" jsonb,
	"seed" integer NOT NULL,
	"llm_enabled" boolean DEFAULT false NOT NULL,
	"chaos_rate" numeric(4, 3) DEFAULT '0' NOT NULL,
	"metrics" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eval_run_id" uuid NOT NULL,
	"profile" text NOT NULL,
	"true_mastery" jsonb NOT NULL,
	"true_learn_rate" numeric(4, 3) NOT NULL,
	"outcome" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_version" integer NOT NULL,
	"student_id" uuid NOT NULL,
	"subtopic_id" text NOT NULL,
	"resource_id" text,
	"action" text NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"duration_min" integer NOT NULL,
	"priority" numeric(5, 2),
	"predicted_score" numeric(4, 3),
	"expected_mastery_after" numeric(4, 3),
	"status" text DEFAULT 'planned' NOT NULL,
	"completed_at" timestamp with time zone,
	"actual_duration_min" integer,
	"self_rated_difficulty" smallint,
	"carried_from_activity_id" uuid,
	"provisional" boolean DEFAULT false NOT NULL,
	"resource_verified" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"subject_id" text NOT NULL,
	"title" text NOT NULL,
	"deadline" date NOT NULL,
	"blueprint" jsonb NOT NULL,
	"target_mastery" jsonb NOT NULL,
	"must_have_subtopics" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mastery_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"subtopic_id" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"mu_before" numeric(4, 3) NOT NULL,
	"mu_after" numeric(4, 3) NOT NULL,
	"confidence_before" numeric(4, 3) NOT NULL,
	"confidence_after" numeric(4, 3) NOT NULL,
	"evidence" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"parent_version" integer,
	"trigger" text NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"diff" jsonb,
	"gap_snapshot" jsonb,
	"projection" jsonb,
	"validation_report" jsonb,
	"repair_rounds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "question_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"assessment_id" uuid,
	"chosen_index" smallint NOT NULL,
	"correct" boolean NOT NULL,
	"time_sec" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "question_state" (
	"student_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"times_seen" integer DEFAULT 0 NOT NULL,
	"times_correct" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "question_state_student_id_question_id_pk" PRIMARY KEY("student_id","question_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"subtopic_id" text NOT NULL,
	"concept_id" text,
	"difficulty" smallint NOT NULL,
	"stem" text NOT NULL,
	"options" jsonb NOT NULL,
	"correct_index" smallint NOT NULL,
	"explanation" text NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"resource_id" text NOT NULL,
	"rating" text NOT NULL,
	"observed_mastery_gain" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"provider" text NOT NULL,
	"url" text NOT NULL,
	"type" text NOT NULL,
	"difficulty" smallint NOT NULL,
	"duration_min" integer NOT NULL,
	"quality" numeric(3, 2) NOT NULL,
	"topic_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"subtopic_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"concept_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text NOT NULL,
	"embedding" vector(1536),
	"last_verified_at" timestamp with time zone,
	"is_live" boolean DEFAULT true NOT NULL,
	"verification_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "student_constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"weekly_availability" jsonb NOT NULL,
	"max_daily_study_min" integer NOT NULL,
	"min_session_min" integer NOT NULL,
	"max_session_min" integer NOT NULL,
	"blackout_dates" date[] DEFAULT '{}'::date[] NOT NULL,
	"preferred_formats" text[] DEFAULT '{}'::text[] NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"sim_now" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "study_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subjects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subtopic_mastery" (
	"student_id" uuid NOT NULL,
	"subtopic_id" text NOT NULL,
	"mu" numeric(4, 3) NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"learn_rate" numeric(4, 3) DEFAULT '0.10' NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"retention_estimate" numeric(4, 3),
	"strength_days" numeric(5, 2),
	"format_efficacy" jsonb DEFAULT '{"video":0.10,"article":0.10,"practice":0.10}'::jsonb NOT NULL,
	"last_observed_at" timestamp with time zone,
	CONSTRAINT "subtopic_mastery_student_id_subtopic_id_pk" PRIMARY KEY("student_id","subtopic_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subtopic_prerequisites" (
	"subtopic_id" text NOT NULL,
	"prereq_id" text NOT NULL,
	"strength" numeric(3, 2) DEFAULT '1.0' NOT NULL,
	CONSTRAINT "subtopic_prerequisites_subtopic_id_prereq_id_pk" PRIMARY KEY("subtopic_id","prereq_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subtopics" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"name" text NOT NULL,
	"weight" numeric(4, 3) NOT NULL,
	"base_hours" numeric(4, 1) NOT NULL,
	"difficulty" smallint NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_health" (
	"tool_name" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"last_error" text,
	"last_success_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topic_prerequisites" (
	"topic_id" text NOT NULL,
	"prereq_id" text NOT NULL,
	"strength" numeric(3, 2) DEFAULT '1.0' NOT NULL,
	CONSTRAINT "topic_prerequisites_topic_id_prereq_id_pk" PRIMARY KEY("topic_id","prereq_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_id" text NOT NULL,
	"name" text NOT NULL,
	"weight" numeric(4, 3) NOT NULL,
	"base_hours" numeric(4, 1) NOT NULL,
	"difficulty" smallint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_results" ADD CONSTRAINT "assessment_results_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "concepts" ADD CONSTRAINT "concepts_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_students" ADD CONSTRAINT "eval_students_eval_run_id_eval_runs_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learning_activities" ADD CONSTRAINT "learning_activities_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learning_activities" ADD CONSTRAINT "learning_activities_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_study_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."study_plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "questions" ADD CONSTRAINT "questions_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "questions" ADD CONSTRAINT "questions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "questions" ADD CONSTRAINT "questions_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "questions" ADD CONSTRAINT "questions_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "student_constraints" ADD CONSTRAINT "student_constraints_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "study_plans" ADD CONSTRAINT "study_plans_goal_id_learning_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subtopic_mastery" ADD CONSTRAINT "subtopic_mastery_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subtopic_mastery" ADD CONSTRAINT "subtopic_mastery_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subtopic_prerequisites" ADD CONSTRAINT "subtopic_prerequisites_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subtopic_prerequisites" ADD CONSTRAINT "subtopic_prerequisites_prereq_id_subtopics_id_fk" FOREIGN KEY ("prereq_id") REFERENCES "public"."subtopics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subtopics" ADD CONSTRAINT "subtopics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "topic_prerequisites" ADD CONSTRAINT "topic_prerequisites_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "topic_prerequisites" ADD CONSTRAINT "topic_prerequisites_prereq_id_topics_id_fk" FOREIGN KEY ("prereq_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "topics" ADD CONSTRAINT "topics_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_events_student_created_idx" ON "agent_events" USING btree ("student_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_events_run_seq_idx" ON "agent_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_running_idx" ON "agent_runs" USING btree ("status") WHERE "agent_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_student_start_idx" ON "calendar_events" USING btree ("student_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_summaries_student_date_idx" ON "daily_summaries" USING btree ("student_id","summary_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_activities_student_start_idx" ON "learning_activities" USING btree ("student_id","scheduled_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_activities_plan_version_idx" ON "learning_activities" USING btree ("plan_id","plan_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_activities_planned_idx" ON "learning_activities" USING btree ("student_id","status") WHERE "learning_activities"."status" = 'planned';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_goals_student_status_idx" ON "learning_goals" USING btree ("student_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mastery_observations_student_subtopic_idx" ON "mastery_observations" USING btree ("student_id","subtopic_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_versions_plan_version_idx" ON "plan_versions" USING btree ("plan_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_subtopic_difficulty_idx" ON "questions" USING btree ("subtopic_id","difficulty");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "student_constraints_effective_idx" ON "student_constraints" USING btree ("student_id","effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_embedding_ivfflat_idx" ON "resources" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 10);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_subtopic_ids_gin_idx" ON "resources" USING GIN ("subtopic_ids");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_topic_ids_gin_idx" ON "resources" USING GIN ("topic_ids");