# release runs before each deploy goes live: db:prepare (create DB on first deploy, migrate
# thereafter) + load the solid queue/cache/cable schemas into the single Heroku database.
# See bin/release for why the solid schemas need loading explicitly on a collapsed single DB.
release: bin/release
web: bundle exec puma -C config/puma.rb
# solid_queue worker. The app enqueues no jobs today, but the dyno is here so background work
# (e.g. async analysis, webhooks) is a code change, not an infra change.
worker: bin/jobs
