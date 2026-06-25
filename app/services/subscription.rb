# Deterministic coaching gate for the HEADLESS coach. Coaching is a paid feature; the headless
# Agent API session is bypassUser (the agent has no idea who the end user is), so — unlike the MIAW
# coach, which gates inside the agent via an Apex action — the headless path must be gated HERE, in
# Rails, where we know current_user. We read the SAME source of truth the MIAW coach uses:
# Contact.Is_Subscribed__c, queried by email via SOQL with the ECA token (SalesforceQuery).
#
# Cached briefly (Solid Cache) so we don't SOQL on every move; a Setup flip reflects within the TTL.
# Fails CLOSED: any error, or no matching Contact, → not subscribed (never coach when unconfirmed).
class Subscription
  CACHE_TTL = 5.minutes
  CACHE_PREFIX = "subscription:active".freeze

  class << self
    # True only if a Contact with this email exists AND Is_Subscribed__c is true.
    def active?(email)
      email = email.to_s.strip.downcase
      return false if email.blank?

      Rails.cache.fetch("#{CACHE_PREFIX}:#{email}", expires_in: CACHE_TTL) do
        query_active(email)
      end
    end

    # Drop the cached decision for an email (e.g. after flipping the flag in Setup during a demo).
    def bust(email)
      Rails.cache.delete("#{CACHE_PREFIX}:#{email.to_s.strip.downcase}")
    end

    private

    def query_active(email)
      soql = "SELECT Is_Subscribed__c FROM Contact WHERE Email = #{SalesforceQuery.quote(email)} LIMIT 1"
      result = SalesforceQuery.new.query(soql)
      records = result["records"]
      return false unless records.is_a?(Array) && records.any?

      records.first["Is_Subscribed__c"] == true
    rescue SalesforceQuery::Error, AgentforceToken::Error => e
      # Fail closed — no free coaching when we can't confirm a subscription.
      Rails.logger.warn("[subscription] check failed for #{email} (treating as unsubscribed): #{e.message}")
      false
    end
  end
end
