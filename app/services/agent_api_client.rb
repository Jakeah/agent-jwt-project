require "net/http"
require "uri"
require "json"

# Thin client for the Agentforce Agent API — the headless, server-to-server REST interface that
# lets Rails drive the Chess_Coach_MCP agent (start a session, send messages, end the session).
# This is what makes the coach *proactive*: because we own the send, the app can auto-post after
# each player move and render the agent's grounded reply (something MIAW's reactive widget can't).
#
# Grounded against developer.salesforce.com/docs/ai/agentforce (2026-06-24):
#   Base:  https://api.salesforce.com   (from the deployment's api_base)
#   Start: POST   /einstein/ai-agent/v1/agents/{AGENT_ID}/sessions
#   Send:  POST   /einstein/ai-agent/v1/sessions/{SESSION_ID}/messages
#   End:   DELETE /einstein/ai-agent/v1/sessions/{SESSION_ID}
#   Auth:  Bearer <client-credentials token from AgentforceToken>
#   The send call is synchronous and can take a while (the agent runs tools), so read_timeout is
#   generous (120s, per the docs); a timeout surfaces as a clean error rather than a 500 trace.
#
# Net::HTTP (stdlib) keeps us off a new gem dependency. One 401 retry covers a token that expired
# between mint and use.
class AgentApiClient
  READ_TIMEOUT = 120 # the agent may run engine tools before replying
  OPEN_TIMEOUT = 10

  class Error < StandardError; end
  class TimeoutError < Error; end

  def initialize(deployment: AgentDeployment.agent_api, token_provider: nil)
    @deployment = deployment || raise(Error, "No agent_api deployment configured")
    @token_provider = token_provider || AgentforceToken.new(deployment: @deployment)
  end

  # Start a session for this agent. external_key is a caller-supplied UUID that lets us correlate
  # the session in Agentforce event logs. Returns the parsed body (includes sessionId).
  def start_session(external_key:)
    path = "/einstein/ai-agent/v1/agents/#{@deployment.agent_id}/sessions"
    body = {
      externalSessionKey: external_key,
      instanceConfig: { endpoint: @deployment.my_domain_url },
      # bypassUser: route as the agent's Run-As user (headless), not a specific end user.
      bypassUser: true,
    }
    request(:post, path, body)
  end

  # Send one text message. `seq` is a per-session monotonically increasing sequenceId; the caller
  # owns it (we cache it alongside the session id). Returns the parsed body (includes messages[]).
  def send_message(session_id:, seq:, text:)
    path = "/einstein/ai-agent/v1/sessions/#{session_id}/messages"
    body = {
      message: {
        sequenceId: seq,
        type: "Text",
        text: text,
      },
    }
    request(:post, path, body)
  end

  # End a session. Best-effort: a failure here shouldn't blow up game-over/sign-out.
  def end_session(session_id:)
    path = "/einstein/ai-agent/v1/sessions/#{session_id}"
    request(:delete, path)
  rescue Error => e
    Rails.logger.warn("[agent_api] end_session failed (ignored): #{e.message}")
    nil
  end

  # Pull the agent's reply text out of a send_message response. The API returns a messages array;
  # we concatenate the text of the agent's message(s). Kept tolerant of shape drift.
  def self.reply_text(send_response)
    messages = send_response.is_a?(Hash) ? send_response["messages"] : nil
    return "" unless messages.is_a?(Array)

    messages.filter_map { |m| m["message"] || m["text"] }.join("\n").strip
  end

  private

  # One HTTP round-trip with a single 401 retry (token may have just expired). Returns parsed
  # JSON (or {} for empty bodies like DELETE 204).
  def request(method, path, body = nil, retried: false)
    uri = URI.parse("#{@deployment.api_base}#{path}")
    res = perform(method, uri, body, @token_provider.access_token)

    if res.code.to_i == 401 && !retried
      # Token likely expired between mint and use — force a fresh one and retry once.
      @token_provider.refresh!
      return request(method, path, body, retried: true)
    end

    unless res.is_a?(Net::HTTPSuccess)
      raise Error, "Agent API #{method.upcase} #{path} failed: #{res.code} #{res.body}"
    end

    res.body.present? ? JSON.parse(res.body) : {}
  rescue JSON::ParserError => e
    raise Error, "Agent API response was not JSON: #{e.message}"
  end

  def perform(method, uri, body, token)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = (uri.scheme == "https")
    http.open_timeout = OPEN_TIMEOUT
    http.read_timeout = READ_TIMEOUT

    request = build_request(method, uri)
    request["Authorization"] = "Bearer #{token}"
    request["Accept"] = "application/json"
    if body
      request["Content-Type"] = "application/json"
      request.body = body.to_json
    end

    http.request(request)
  rescue Net::OpenTimeout, Net::ReadTimeout => e
    raise TimeoutError, "Agent API #{method.upcase} timed out: #{e.message}"
  end

  def build_request(method, uri)
    case method
    when :post   then Net::HTTP::Post.new(uri.request_uri)
    when :delete then Net::HTTP::Delete.new(uri.request_uri)
    when :get    then Net::HTTP::Get.new(uri.request_uri)
    else raise Error, "Unsupported HTTP method: #{method}"
    end
  end
end
