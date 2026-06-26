# Ensures a Salesforce Contact exists for an app user and marks it subscribed, so a newly
# registered player can use the coach immediately (coaching is gated on Contact.Is_Subscribed__c —
# see Subscription / the MIAW agent gate).
#
# Idempotent UPSERT keyed on Email (Email isn't a Salesforce external id, so we can't use the native
# upsert endpoint): query by email → PATCH the existing Contact if found, else POST a new one. Safe
# to re-run (re-signup, retries, an already-seeded Contact) without creating duplicates.
#
# Best-effort by design — callers run this in a background job (see EnsureContactJob). A Salesforce
# hiccup must never break account creation; failures raise so the job can retry, and are logged.
class SalesforceContactSync
  class Error < StandardError; end

  def self.upsert_subscribed(email:, first_name: nil)
    new.upsert_subscribed(email: email, first_name: first_name)
  end

  def initialize(client: SalesforceQuery.new)
    @client = client
  end

  # Create-or-update the Contact for this email with Is_Subscribed__c = true. Returns the Contact Id.
  def upsert_subscribed(email:, first_name: nil)
    email = email.to_s.strip
    raise Error, "email required" if email.blank?

    fields = { "Is_Subscribed__c" => true }
    existing_id = find_contact_id(email)

    if existing_id
      @client.update("Contact", existing_id, fields)
      id = existing_id
    else
      # New Contact: LastName is required on Contact; derive a friendly name from the email local part.
      local = email.split("@").first.to_s
      fields = fields.merge(
        "Email" => email,
        "LastName" => (first_name.presence || local.split(/[._]/).first.presence || "Player").capitalize,
      )
      result = @client.create("Contact", fields)
      raise Error, "Contact create did not return an id: #{result.inspect}" unless result["id"]
      id = result["id"]
    end

    # The headless coach caches the subscription decision per email (~5 min); drop it so the new
    # user can coach right away instead of waiting out a stale "false".
    Subscription.bust(email)
    id
  rescue SalesforceQuery::Error => e
    raise Error, "Contact upsert failed for #{email}: #{e.message}"
  end

  private

  def find_contact_id(email)
    soql = "SELECT Id FROM Contact WHERE Email = #{SalesforceQuery.quote(email)} LIMIT 1"
    records = @client.query(soql)["records"]
    records&.first&.dig("Id")
  end
end
