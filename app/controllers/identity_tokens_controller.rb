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
    token = IdentityToken.new(user: current_user, deployment: deployment).to_jwt

    render json: {
      identityTokenType: "JWT",
      identityToken: token,
      deployment: deployment.name,
    }
  rescue ArgumentError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end
end
