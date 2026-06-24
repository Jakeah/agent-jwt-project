require "net/http"
require "uri"
require "json"

# Mints (and caches) an OAuth access token for the Agentforce Agent API using the External
# Client App's client-credentials flow. This is the server-to-server counterpart to IdentityToken
# (which verifies the END USER to MIAW); here we authenticate the APP to Salesforce so Rails can
# drive a headless agent via the Agent API.
#
#   POST {my_domain}/services/oauth2/token
#     grant_type=client_credentials
#     client_id=<consumer key>        ← ENV["AGENTFORCE_CONSUMER_KEY"]
#     client_secret=<consumer secret> ← ENV["AGENTFORCE_CONSUMER_SECRET"]
#   → { access_token, instance_url, token_type, expires_in, ... }
#
# Secrets come from ENV (Heroku config vars), never the repo — same discipline as the RS256
# signing key. The token is cached in Rails.cache (Solid Cache in prod) and reused until ~60s
# before it expires, so a burst of moves doesn't mint a token per turn. We cache the token
# together with its absolute expiry so the response's real `expires_in` sizes the window (rather
# than a guess applied one mint late).
class AgentforceToken
  CACHE_KEY = "agentforce:agent_api:access_token".freeze
  EXPIRY_SKEW = 60        # treat the token as expired this many seconds early
  DEFAULT_TTL = 1800      # fallback if the response omits expires_in

  class Error < StandardError; end

  def initialize(deployment: AgentDeployment.agent_api)
    @deployment = deployment || raise(Error, "No agent_api deployment configured")
  end

  # A usable bearer token. Returns the cached one while it's still fresh; otherwise mints,
  # caches, and returns a new one.
  def access_token
    cached = Rails.cache.read(CACHE_KEY)
    return cached[:token] if cached && cached[:expires_at] > Time.current.to_i

    mint_and_cache
  end

  # Force a fresh mint (e.g. after a 401) and re-cache it.
  def refresh!
    Rails.cache.delete(CACHE_KEY)
    mint_and_cache
  end

  private

  attr_reader :deployment

  def mint_and_cache
    token, expires_in = mint
    # Store with an absolute expiry skewed early; keep the cache entry itself a touch longer than
    # the token so reads always find it and decide freshness on expires_at.
    Rails.cache.write(
      CACHE_KEY,
      { token: token, expires_at: Time.current.to_i + expires_in - EXPIRY_SKEW },
      expires_in: expires_in.seconds,
    )
    token
  end

  # → [access_token, expires_in]
  def mint
    uri = URI.parse("#{deployment.my_domain_url}/services/oauth2/token")
    body = URI.encode_www_form(
      grant_type: "client_credentials",
      client_id: consumer_key,
      client_secret: consumer_secret,
    )

    res = post_form(uri, body)
    unless res.is_a?(Net::HTTPSuccess)
      raise Error, "OAuth token request failed: #{res.code} #{res.body}"
    end

    json = JSON.parse(res.body)
    [json.fetch("access_token"), (json["expires_in"]&.to_i || DEFAULT_TTL)]
  rescue JSON::ParserError => e
    raise Error, "OAuth token response was not JSON: #{e.message}"
  end

  def post_form(uri, body)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = (uri.scheme == "https")
    http.open_timeout = 10
    http.read_timeout = 30

    request = Net::HTTP::Post.new(uri.request_uri)
    request["Content-Type"] = "application/x-www-form-urlencoded"
    request["Accept"] = "application/json"
    request.body = body
    http.request(request)
  end

  def consumer_key
    ENV["AGENTFORCE_CONSUMER_KEY"].presence ||
      raise(Error, "AGENTFORCE_CONSUMER_KEY is not set")
  end

  def consumer_secret
    ENV["AGENTFORCE_CONSUMER_SECRET"].presence ||
      raise(Error, "AGENTFORCE_CONSUMER_SECRET is not set")
  end
end
