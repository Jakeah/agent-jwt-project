require "test_helper"

class IdentityTokensTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = User.create!(email: "verify@example.com", password: "password123")
  end

  test "anonymous request is bounced to sign in (no token issued)" do
    get identity_token_path
    assert_redirected_to new_user_session_path
  end

  test "authenticated request returns a JWT shaped for setIdentityToken" do
    sign_in @user
    get identity_token_path

    assert_response :success
    body = JSON.parse(response.body)
    assert_equal "JWT", body["identityTokenType"]
    assert body["identityToken"].present?, "must return a token"
    assert_equal AgentDeployment.default.name, body["deployment"]

    # The returned token is a real RS256 JWT bound to this user.
    payload, = JWT.decode(body["identityToken"], IdentityToken.public_key, true, { algorithm: "RS256" })
    assert_equal @user.email, payload["sub"]
  end

  test "token response is non-cacheable (no ETag/304 serving a stale short-lived token)" do
    sign_in @user
    get identity_token_path

    assert_response :success
    # Rails' default ETag would let the browser get a 304 and reuse a cached (expired) token,
    # which Salesforce rejects. The endpoint must forbid caching.
    assert_includes response.headers["Cache-Control"].to_s, "no-store"
    assert_nil response.headers["ETag"], "a credential endpoint must not emit an ETag"
  end

  test "explicit unknown deployment param is a 422 (no silent fallback to wrong agent)" do
    sign_in @user
    get identity_token_path(deployment: "no_such_deployment")
    assert_response :unprocessable_entity
    assert_match(/unknown agent deployment/i, JSON.parse(response.body)["error"])
  end

  test "explicit known deployment round-trips in the response" do
    sign_in @user
    get identity_token_path(deployment: AgentDeployment.default.name)
    assert_response :success
    assert_equal AgentDeployment.default.name, JSON.parse(response.body)["deployment"]
  end
end
