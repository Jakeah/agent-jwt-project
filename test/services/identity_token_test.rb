require "test_helper"

class IdentityTokenTest < ActiveSupport::TestCase
  setup do
    @user = User.create!(email: "verify@example.com", password: "password123")
    @deployment = AgentDeployment.default
  end

  test "mints an RS256 JWT that verifies against the public key with expected claims" do
    jwt = IdentityToken.new(user: @user, deployment: @deployment).to_jwt

    payload, header = JWT.decode(
      jwt, IdentityToken.public_key, true,
      { algorithm: "RS256", aud: @deployment.audience, verify_aud: true }
    )

    assert_equal "RS256", header["alg"]
    assert_equal @deployment.key_id, header["kid"]
    assert_equal @user.email, payload["sub"]
    assert_equal @deployment.issuer, payload["iss"]
    assert_equal @deployment.audience, payload["aud"]
    assert payload["exp"] > payload["iat"], "exp must be after iat"
  end

  test "token expires after the deployment ttl" do
    now = Time.current
    payload = IdentityToken.new(user: @user, deployment: @deployment).payload(now)
    assert_equal @deployment.token_ttl_seconds, payload[:exp] - payload[:iat]
  end

  test "tampered token fails verification" do
    jwt = IdentityToken.new(user: @user, deployment: @deployment).to_jwt
    tampered = jwt[0..-3] + (jwt[-2] == "a" ? "bb" : "aa")

    assert_raises(JWT::VerificationError, JWT::DecodeError) do
      JWT.decode(tampered, IdentityToken.public_key, true, { algorithm: "RS256" })
    end
  end
end
