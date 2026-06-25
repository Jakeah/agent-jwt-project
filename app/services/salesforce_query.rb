require "net/http"
require "uri"
require "json"

# Minimal SOQL reader against the Salesforce REST Data API, reusing the SAME External Client App
# bearer that drives the Agent API (AgentforceToken). The ECA's client-credentials token already
# carries the `api` scope (verified in-org), so no new credential is needed — Rails can read org
# data (e.g. a Contact's subscription flag) with what it already has.
#
#   GET {my_domain}/services/data/v{API}/query?q=<SOQL>
#   Authorization: Bearer <ECA token>
#
# SOQL runs against the My Domain host (the Data API), NOT api.salesforce.com (that's the Agent
# API base) — so we use the deployment's my_domain_url. Net::HTTP (stdlib, no new gem) + the same
# single-401-retry idiom as AgentApiClient: a token can expire between mint and use.
class SalesforceQuery
  API_VERSION = "v60.0".freeze
  OPEN_TIMEOUT = 10
  READ_TIMEOUT = 20

  class Error < StandardError; end

  def initialize(deployment: AgentDeployment.agent_api, token_provider: nil)
    @deployment = deployment || raise(Error, "No agent_api deployment configured")
    @token_provider = token_provider || AgentforceToken.new(deployment: @deployment)
  end

  # Run a SOQL query, returning the parsed response Hash (with "records"). Raises Error on failure.
  def query(soql)
    path = "/services/data/#{API_VERSION}/query?q=#{URI.encode_www_form_component(soql)}"
    request(:get, path)
  end

  # Convenience: SOQL-escape a value for safe interpolation inside single quotes. SOQL string
  # literals escape backslash and single-quote with a backslash.
  def self.quote(value)
    "'#{value.to_s.gsub('\\', '\\\\\\\\').gsub("'", "\\\\'")}'"
  end

  private

  def request(method, path, retried: false)
    uri = URI.parse("#{@deployment.my_domain_url}#{path}")
    res = perform(method, uri, @token_provider.access_token)

    if res.code.to_i == 401 && !retried
      @token_provider.refresh!
      return request(method, path, retried: true)
    end

    unless res.is_a?(Net::HTTPSuccess)
      raise Error, "SOQL #{method.upcase} failed: #{res.code} #{res.body}"
    end

    res.body.present? ? JSON.parse(res.body) : {}
  rescue JSON::ParserError => e
    raise Error, "SOQL response was not JSON: #{e.message}"
  end

  def perform(method, uri, token)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = (uri.scheme == "https")
    http.open_timeout = OPEN_TIMEOUT
    http.read_timeout = READ_TIMEOUT

    req = Net::HTTP::Get.new(uri.request_uri)
    req["Authorization"] = "Bearer #{token}"
    req["Accept"] = "application/json"
    http.request(req)
  rescue Net::OpenTimeout, Net::ReadTimeout => e
    raise Error, "SOQL #{method.upcase} timed out: #{e.message}"
  end
end
