# Mints a short-lived RS256 JWT that Salesforce Messaging for In-App and Web (MIAW) accepts as
# a User Verification identity token. The browser passes the result to
# `embeddedservice_bootstrap.userVerificationAPI.setIdentityToken({ identityTokenType: "JWT", identityToken })`.
#
# Salesforce holds the matching PUBLIC key (registered in Setup → User Verification). We sign
# with the PRIVATE key, which is read from the IDENTITY_JWT_PRIVATE_KEY env var (Heroku config
# var in prod; local file in dev/test — see private_key).
#
# One signer serves every org/agent: the per-deployment audience and key id come from the
# AgentDeployment registry, so the same code path covers SOMA and MOMA.
#
# NOTE (Phase 4): the exact claim set Salesforce requires for the subject→Contact mapping is
# confirmed against the live Setup UI. `sub` = the user's verified email is the working
# assumption; adjust here once confirmed.
class IdentityToken
  ALGORITHM = "RS256".freeze

  def initialize(user:, deployment:, reset_nonce: nil)
    @user = user
    @deployment = deployment
    @reset_nonce = reset_nonce.presence
  end

  def to_jwt(now: Time.current)
    JWT.encode(payload(now), self.class.private_key, ALGORITHM, headers)
  end

  def payload(now = Time.current)
    {
      iss: @deployment.issuer,
      sub: subject,                     # subject → matched to a Salesforce Contact
      aud: @deployment.audience,
      iat: now.to_i,
      exp: (now + @deployment.token_ttl_seconds).to_i,
    }
  end

  # The verified subject Salesforce keys the conversation on (and maps to a Contact). Normally the
  # user's email. For a "New chat" reset the browser sends a short nonce, which we splice in as a
  # `+r<nonce>` sub-address (local+r<nonce>@domain).
  #
  # WHY: a verified MIAW conversation is pinned to the JWT subject — SCRT2 RESUMES the same
  # conversation for the same subject, so clearSession + launchChat alone never start fresh (the
  # continuity trap; see docs/miaw-prechat-to-agent-guide.md). A never-before-seen subject is the
  # only thing that forces a brand-new conversation. The routing flow's Verified_Email formula
  # strips the `+r<nonce>` tag back to the real email so Get_Contact still matches the right Contact.
  def subject
    return @user.email unless @reset_nonce

    local, sep, domain = @user.email.rpartition("@")
    return @user.email if sep.empty? || domain.blank? # malformed → don't risk an unmatched subject

    nonce = @reset_nonce.gsub(/[^a-zA-Z0-9]/, "") # keep it tag-safe; flow splits on '+'..'@'
    return @user.email if nonce.blank?

    "#{local}+r#{nonce}@#{domain}"
  end

  def headers
    { kid: @deployment.key_id, typ: "JWT" }
  end

  class << self
    # RSA private key for signing. Prefer the env var (works identically on Heroku); fall back
    # to the local PEM file in development/test so the dev loop needs no env setup.
    def private_key
      @private_key ||= OpenSSL::PKey::RSA.new(private_key_pem)
    end

    # Public key — handy for tests/verification and for re-exporting to Salesforce.
    def public_key
      @public_key ||= private_key.public_key
    end

    def reset!
      @private_key = @public_key = nil
    end

    private

    def private_key_pem
      env = ENV["IDENTITY_JWT_PRIVATE_KEY"]
      return env if env.present?

      path = Rails.root.join("config", "keys", "identity_jwt.private.pem")
      return File.read(path) if File.exist?(path)

      raise "No identity JWT private key: set IDENTITY_JWT_PRIVATE_KEY or add config/keys/identity_jwt.private.pem"
    end
  end
end
