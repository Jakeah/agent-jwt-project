# Ensures a subscribed Salesforce Contact exists for a newly registered user, off the request path.
#
# Runs async (Solid Queue) so signup isn't blocked on a Salesforce round-trip and a Salesforce
# outage can't fail account creation. The upsert is idempotent, so retries are safe; we retry a few
# times on transient API errors, then give up quietly (the Contact can also be created/flipped in
# Setup, and the user can still play — only coaching is gated).
class EnsureContactJob < ApplicationJob
  queue_as :default

  retry_on SalesforceContactSync::Error, wait: :polynomially_longer, attempts: 5

  def perform(email, first_name = nil)
    SalesforceContactSync.upsert_subscribed(email: email, first_name: first_name)
  end
end
