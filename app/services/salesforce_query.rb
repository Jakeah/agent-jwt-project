require "net/http"
require "uri"
require "json"

# Minimal reader/writer against the Salesforce REST Data API, reusing the SAME External Client App
# bearer that drives the Agent API (AgentforceToken). The ECA's client-credentials token already
# carries the `api` scope (verified in-org — read AND write), so no new credential is needed.
#
#   GET    {my_domain}/services/data/v{API}/query?q=<SOQL>
#   POST   {my_domain}/services/data/v{API}/sobjects/<Object>           (create)
#   PATCH  {my_domain}/services/data/v{API}/sobjects/<Object>/<Id>      (update)
#   Authorization: Bearer <ECA token>
#
# The Data API lives on the My Domain host (NOT api.salesforce.com, which is the Agent API base) —
# so we use the deployment's my_domain_url. Net::HTTP (stdlib, no new gem) + the same single-401-
# retry idiom as AgentApiClient: a token can expire between mint and use.
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

  # Create an sObject record. Returns the parsed body ({ "id", "success", ... }). Raises on failure.
  def create(sobject, fields)
    request(:post, "/services/data/#{API_VERSION}/sobjects/#{sobject}", body: fields)
  end

  # Update fields on an existing sObject by Id. PATCH returns 204 (no body) on success.
  def update(sobject, id, fields)
    request(:patch, "/services/data/#{API_VERSION}/sobjects/#{sobject}/#{id}", body: fields)
  end

  # Convenience: SOQL-escape a value for safe interpolation inside single quotes. SOQL string
  # literals escape backslash and single-quote with a backslash.
  def self.quote(value)
    "'#{value.to_s.gsub('\\', '\\\\\\\\').gsub("'", "\\\\'")}'"
  end

  private

  def request(method, path, body: nil, retried: false)
    uri = URI.parse("#{@deployment.my_domain_url}#{path}")
    res = perform(method, uri, @token_provider.access_token, body)

    if res.code.to_i == 401 && !retried
      @token_provider.refresh!
      return request(method, path, body: body, retried: true)
    end

    unless res.is_a?(Net::HTTPSuccess)
      raise Error, "Data API #{method.upcase} failed: #{res.code} #{res.body}"
    end

    res.body.present? ? JSON.parse(res.body) : {}
  rescue JSON::ParserError => e
    raise Error, "Data API response was not JSON: #{e.message}"
  end

  def perform(method, uri, token, body)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = (uri.scheme == "https")
    http.open_timeout = OPEN_TIMEOUT
    http.read_timeout = READ_TIMEOUT

    req = build_request(method, uri)
    req["Authorization"] = "Bearer #{token}"
    req["Accept"] = "application/json"
    if body
      req["Content-Type"] = "application/json"
      req.body = body.to_json
    end
    http.request(req)
  rescue Net::OpenTimeout, Net::ReadTimeout => e
    raise Error, "Data API #{method.upcase} timed out: #{e.message}"
  end

  def build_request(method, uri)
    case method
    when :get   then Net::HTTP::Get.new(uri.request_uri)
    when :post  then Net::HTTP::Post.new(uri.request_uri)
    when :patch then Net::HTTP::Patch.new(uri.request_uri)
    else raise Error, "Unsupported HTTP method: #{method}"
    end
  end
end
