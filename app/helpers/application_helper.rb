module ApplicationHelper
  # The Agentforce deployment the embedded chat widget should use. Single-deployment today
  # (the registry default); when SOMA/MOMA adds entries, swap this for a per-page/per-user
  # selection without touching the layout.
  def current_agent_deployment
    AgentDeployment.default
  end

  # Distinct origins (scheme://host) the MIAW widget connects to at boot, for <head> resource hints
  # (preconnect/dns-prefetch) so DNS+TLS is warm before the bootstrap runs. ESW init touches the
  # Experience site (assets), the SCRT2 messaging host, and the org My Domain (audience/verification).
  def miaw_preconnect_origins(deployment)
    return [] unless deployment&.miaw?

    [deployment.site_url, deployment.scrt2_url, deployment.audience]
      .compact
      .filter_map { |u| u[%r{\Ahttps?://[^/]+}] } # scheme://host only
      .uniq
  end
end
