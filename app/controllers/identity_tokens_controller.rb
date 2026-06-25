# Issues a short-lived RS256 identity token for the authenticated user, scoped to a specific
# Agentforce deployment (?deployment=<name>, defaults to the registry default).
#
# The browser hands the returned token to the MIAW widget via setIdentityToken. Because the
# endpoint requires an authenticated Devise session, an anonymous visitor simply can't obtain
# a token — their chat stays unverified. That session-gate IS the trust boundary.
class IdentityTokensController < ApplicationController
  before_action :authenticate_user!

  def show
    deployment = AgentDeployment.resolve(params[:deployment])
    # Optional reset nonce: when the user hits "New chat", the browser sends a fresh value so we
    # mint a unique subject (local+r<nonce>@domain) and Salesforce starts a NEW verified
    # conversation instead of resuming the pinned one (the continuity trap). Absent on normal mints.
    token = IdentityToken.new(
      user: current_user,
      deployment: deployment,
      reset_nonce: params[:reset],
    ).to_jwt

    prevent_token_caching!

    render json: {
      identityTokenType: "JWT",
      identityToken: token,
      deployment: deployment.name,
    }
  rescue ArgumentError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  # A freshly-minted, short-lived credential must NEVER be reused from an HTTP cache. By default
  # Rails' Rack::ETag adds a weak ETag to this 200 response, so the browser sends a conditional
  # request, gets 304 Not Modified, and serves the CACHED (now-stale) token. Within the 5-min TTL
  # that stale token reaches setIdentityToken and Salesforce rejects it ("Something went wrong"),
  # which can also drive the rejection→re-mint cycle.
  #
  # Two parts, because they do different jobs:
  #   - Cache-Control: no-store tells the BROWSER never to store the token body.
  #   - Rack::ETag only skips emitting an ETag when the response ALREADY carries an ETag or
  #     Last-Modified header (it ignores Cache-Control entirely — confirmed in rack 3.x
  #     etag.rb#skip_caching?). Setting Last-Modified makes it skip, so there's no ETag → no 304 →
  #     a fresh token every request.
  def prevent_token_caching!
    response.cache_control.replace(no_store: true)
    response.headers["Pragma"] = "no-cache"
    response.headers["Last-Modified"] = Time.current.httpdate # makes Rack::ETag skip the ETag
  end
end
