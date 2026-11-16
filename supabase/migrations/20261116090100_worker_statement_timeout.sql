-- =============================================================================
-- More time for the server-side import worker.
--
-- Requests through the Data API inherit an 8 s statement timeout. Signed-in
-- users keep it; the service role — used only by the server-side import worker
-- and admin tooling, never by browsers — gets 55 s so validating and applying
-- very large exports (100,000+ rows) cannot hit it. Each worker run is still
-- bounded by its own 45 s budget and the 60 s function limit.
-- =============================================================================

alter role service_role set statement_timeout = '55s';
notify pgrst, 'reload config';
