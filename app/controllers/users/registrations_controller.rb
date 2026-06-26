module Users
  # Adds an invite-passcode gate to Devise sign-up: a new account can only be created when the
  # submitted `signup_code` matches SIGNUP_CODE (env; defaults to "astro-chess"). This is a soft
  # gate to keep the public demo from being opened by just anyone — not a security boundary.
  #
  # Everything else is stock Devise. We check the code before the heavy lifting (and before the
  # User#after_create_commit Contact provisioning), and re-render the form with a clear error +
  # the user's other inputs preserved on a miss.
  class RegistrationsController < Devise::RegistrationsController
    def create
      unless valid_signup_code?
        build_resource(sign_up_params) # so the form re-renders with email preserved
        resource.errors.add(:base, "That invite code isn't right. Ask your host for the code.")
        clean_up_passwords(resource)
        set_minimum_password_length
        respond_with(resource) { |format| format.html { render :new, status: :unprocessable_entity } }
        return
      end

      super
    end

    private

    def valid_signup_code?
      submitted = params.dig(resource_name, :signup_code).to_s.strip
      submitted.present? && ActiveSupport::SecurityUtils.secure_compare(submitted, expected_code)
    end

    def expected_code
      ENV["SIGNUP_CODE"].presence || "astro-chess"
    end
  end
end
