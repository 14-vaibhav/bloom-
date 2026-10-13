CREATE TABLE "llm_cache" (
  "key" text PRIMARY KEY NOT NULL,
  "agent" text NOT NULL,
  "prompt_version" text NOT NULL,
  "response" jsonb NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "hits" integer DEFAULT 0 NOT NULL
);
