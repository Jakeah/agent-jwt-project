# Loads and looks up entries from config/agent_deployments.yml — the SOMA/MOMA registry.
#
# A deployment carries everything its path needs, keyed by `mode`:
#   - mode "miaw":      the JWT minter (issuer, audience, key_id, token_ttl_seconds) + the embed
#                       snippet (org_id, deployment_name, site_url, scrt2_url)
#   - mode "agent_api": the headless Agent API client (agent_id, my_domain_url, api_base). The
#                       OAuth secrets are read from ENV, not stored here.
#
# Usage:
#   AgentDeployment.find("chess_support")  → AgentDeployment or nil
#   AgentDeployment.default                 → the configured default entry
class AgentDeployment
  CONFIG_PATH = Rails.root.join("config", "agent_deployments.yml")

  attr_reader :name, :label, :mode, :org_id, :deployment_name, :site_url, :scrt2_url,
              :issuer, :audience, :key_id, :token_ttl_seconds,
              :agent_id, :my_domain_url, :api_base

  def initialize(name, attrs)
    @name = name
    @label = attrs["label"]
    @mode = attrs["mode"] || "miaw"   # default keeps pre-existing single-entry behavior
    # MIAW (embedded widget + User Verification JWT)
    @org_id = attrs["org_id"]
    @deployment_name = attrs["deployment_name"]
    @site_url = attrs["site_url"]
    @scrt2_url = attrs["scrt2_url"]
    @issuer = attrs["issuer"]
    @audience = attrs["audience"]
    @key_id = attrs["key_id"]
    @token_ttl_seconds = attrs["token_ttl_seconds"] || 300
    # Headless Agent API
    @agent_id = attrs["agent_id"]
    @my_domain_url = attrs["my_domain_url"]
    @api_base = attrs["api_base"]
  end

  def miaw?
    mode == "miaw"
  end

  def agent_api?
    mode == "agent_api"
  end

  class << self
    def find(name)
      raw = config.dig("deployments", name.to_s)
      raw && new(name.to_s, raw)
    end

    def default
      find(config["default_deployment"])
    end

    # Resolve a deployment for a request. No name → the configured default. An explicit but
    # unknown name RAISES rather than silently falling back, so a typo can't mint a token for
    # the wrong agent/audience (a real risk once MOMA/SOMA has many entries).
    def resolve(name)
      if name.present?
        find(name) || raise(ArgumentError, "Unknown agent deployment: #{name.inspect}")
      else
        default || raise(ArgumentError, "No default agent deployment configured")
      end
    end

    def all
      config.fetch("deployments", {}).keys.map { |k| find(k) }
    end

    # The headless Agent API deployment (the MCP coach). First entry with mode: agent_api.
    # Used by AgentChatsController so the registry key isn't hardcoded across the app.
    def agent_api
      all.find(&:agent_api?)
    end

    private

    def config
      # Reload each call in development so registry edits don't require a restart.
      if Rails.env.development?
        load_config
      else
        @config ||= load_config
      end
    end

    def load_config
      YAML.safe_load_file(CONFIG_PATH) || {}
    end
  end
end
