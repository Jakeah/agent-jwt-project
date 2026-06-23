# release runs before each deploy goes live — db:prepare creates the DB on first deploy and
# applies migrations (across the primary + solid cache/queue/cable migration paths) thereafter.
release: bin/rails db:prepare
web: bundle exec puma -C config/puma.rb
# solid_queue worker. The app enqueues no jobs today, but the dyno is here so background work
# (e.g. async analysis, webhooks) is a code change, not an infra change.
worker: bin/jobs
